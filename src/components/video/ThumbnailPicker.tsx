// components/video/ThumbnailPicker.tsx
//
// "Set thumbnail" for the open video: pick any frame (scrub, step frame by frame, or jump from a
// strip of candidate frames) or a picture from disk, then optionally dress it up - text in a few
// tuned looks (bold title, subtitle, caption bar, badge) and logos/images - dragged and resized
// right on the picture. Layers stay put while you try other frames, so finding the right moment
// for a title you've already laid out is just scrubbing.
//
// The preview is always the real pixels about to be used: a frame is snapshotted off the player's
// own <video> once its seek lands (the same frame set_video_thumbnail extracts at that time), and
// layers are laid out in picture-relative units that composeThumbnail (thumbnailLayers.ts) draws
// identically at full size. With no layers a frame/picture is saved exactly as before (ffmpeg
// extracts it straight from the file); with layers the composed picture is sent instead.
//
// Cheap by construction: the candidate strip is drawn from the scrub-bar sprite the player has
// already generated for hover previews (no extra decode), and scrubbing seeks the paused player
// directly, coalescing a fast drag into one seek in flight at a time.
//
// Portalled to <body> above everything (the player's own controls included) - it's a modal, and
// the events it stops here would otherwise still bubble to the player through the React tree.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoChevronBack,
  IoChevronForward,
  IoClose,
  IoCopyOutline,
  IoFilmOutline,
  IoImageOutline,
  IoText,
  IoTrashOutline,
} from "react-icons/io5";
import { MdFormatAlignCenter, MdFormatAlignLeft, MdFormatAlignRight } from "react-icons/md";
import {
  ImageLayer,
  SWATCHES,
  TEXT_PRESETS,
  THUMB_FONTS,
  TextLayer,
  ThumbLayer,
  composeThumbnail,
  imageRadiusFraction,
  loadImage,
  shownTextOf,
  textBoxStyle,
} from "../../utils/thumbnailLayers";

export interface ScrubSpriteMeta {
  url: string;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  count: number;
  interval: number;
}

type BaseChoice = { kind: "frame"; url: string; time: number } | { kind: "image"; url: string; path: string };
// What gets saved: an untouched frame/picture, or the composed picture with its layers drawn in.
export type ThumbnailChoice = BaseChoice | { kind: "composed"; bytes: number[] };

const FRAME_STEP = 1 / 30;
const CANDIDATE_COUNT = 10;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];
const SNAP = 0.015; // how close (fraction of the picture) a dragged centre gets pulled onto a centre line
const NUDGE = 0.005;

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

interface ThumbnailPickerProps {
  video: HTMLVideoElement;
  sprite: ScrubSpriteMeta | null;
  saving: boolean;
  // The last save's failure, shown above the buttons (the picker stays open so it can be retried).
  error?: string | null;
  onSave: (choice: ThumbnailChoice) => void;
  onCancel: () => void;
  // Whether this kind of file can carry the thumbnail inside it (MP4) - only for the note below;
  // the backend makes the final call (embed_cover_and_replace).
  embedsInFile?: boolean;
  // "Also make a share-ready copy" - a copy that OPENS on this thumbnail, for messaging apps.
  shareCopy?: boolean;
  onShareCopyChange?: (on: boolean) => void;
}

const snapshot = (video: HTMLVideoElement): string | null => {
  if (video.videoWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
};

const isTypingTarget = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "range" && el.type !== "checkbox");

const Chip: React.FC<{ active?: boolean; title?: string; onClick: () => void; children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({
  active,
  title,
  onClick,
  children,
  className = "",
  style,
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={style}
    className={`px-2 h-7 rounded text-xs transition-colors ${active ? "bg-blue-600 text-white" : "bg-white/[0.06] text-neutral-200 hover:bg-white/10"} ${className}`}
  >
    {children}
  </button>
);

const SwatchRow: React.FC<{ value: string | null; onChange: (c: string | null) => void; allowNone?: boolean; extra?: string[] }> = ({ value, onChange, allowNone, extra = [] }) => (
  <div className="flex flex-wrap items-center gap-1">
    {allowNone && (
      <button
        type="button"
        title="None"
        onClick={() => onChange(null)}
        className={`w-5 h-5 rounded-full ring-1 ring-white/20 bg-[linear-gradient(135deg,transparent_45%,#ef4444_45%,#ef4444_55%,transparent_55%)] ${value === null ? "ring-2 ring-blue-400" : ""}`}
      />
    )}
    {[...extra, ...SWATCHES].map((c) => (
      <button
        key={c}
        type="button"
        title={c}
        onClick={() => onChange(c)}
        style={{ background: c }}
        className={`w-5 h-5 rounded-full ring-1 ring-white/20 ${value === c ? "ring-2 ring-blue-400 ring-offset-1 ring-offset-neutral-900" : ""}`}
      />
    ))}
    <label title="Custom colour" className="relative w-5 h-5 rounded-full ring-1 ring-white/20 overflow-hidden cursor-pointer bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
      <input
        type="color"
        value={value && value.startsWith("#") ? value : "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      />
    </label>
  </div>
);

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
    {children}
  </div>
);

const ThumbnailPicker: React.FC<ThumbnailPickerProps> = ({ video, sprite, saving, error, onSave, onCancel, embedsInFile, shareCopy, onShareCopyChange }) => {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const [choice, setChoice] = useState<BaseChoice | null>(() => {
    const url = snapshot(video);
    return url ? { kind: "frame", url, time: video.currentTime } : null;
  });
  // Where the slider is - ahead of `choice` while a seek is still landing.
  const [scrubTime, setScrubTime] = useState(video.currentTime);
  const seekingRef = useRef(false);
  const pendingRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [layers, setLayers] = useState<ThumbLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const selected = layers.find((l) => l.id === selectedId) ?? null;

  // The stage is the picture itself, fitted into the space the dialog gives it.
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: video.videoWidth || 16, h: video.videoHeight || 9 });
  useLayoutEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const aspect = natural.w / natural.h;
  const stageW = Math.max(1, Math.min(box.w, box.h * aspect));
  const stageH = stageW / aspect;

  useEffect(() => {
    video.pause();
    rootRef.current?.focus();
  }, [video]);

  useEffect(() => {
    const onSeeked = () => {
      const url = snapshot(video);
      if (url) {
        setChoice({ kind: "frame", url, time: video.currentTime });
        setNatural({ w: video.videoWidth, h: video.videoHeight });
      }
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next !== null && Math.abs(next - video.currentTime) > 0.001) {
        video.currentTime = next;
      } else {
        seekingRef.current = false;
      }
    };
    video.addEventListener("seeked", onSeeked);
    return () => video.removeEventListener("seeked", onSeeked);
  }, [video]);

  const seekTo = useCallback(
    (t: number) => {
      const time = Math.max(0, Math.min(duration > 0 ? duration - 0.01 : 0, t));
      setScrubTime(time);
      if (seekingRef.current) {
        pendingRef.current = time;
        return;
      }
      seekingRef.current = true;
      video.currentTime = time;
    },
    [video, duration]
  );

  const chooseImage = async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (typeof picked !== "string") return;
    setChoice({ kind: "image", url: convertFileSrc(picked), path: picked });
  };

  const stepFrame = (dir: 1 | -1) => seekTo((choice?.kind === "frame" ? scrubTime : video.currentTime) + dir * FRAME_STEP);

  // ---- layers ----------------------------------------------------------------------------------
  const updateLayer = (id: string, patch: Partial<TextLayer> | Partial<ImageLayer>) =>
    setLayers((prev) => prev.map((l) => (l.id === id ? ({ ...l, ...patch } as ThumbLayer) : l)));
  const addLayer = (layer: ThumbLayer) => {
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
    if (layer.kind === "text") requestAnimationFrame(() => textInputRef.current?.select());
  };
  const removeLayer = (id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedId(null);
  };
  const duplicateLayer = (l: ThumbLayer) => addLayer({ ...l, id: crypto.randomUUID(), x: Math.min(0.95, l.x + 0.04), y: Math.min(0.95, l.y + 0.04) });

  const addLogo = async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (typeof picked !== "string") return;
    const src = convertFileSrc(picked);
    try {
      const img = await loadImage(src);
      const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
      const width = 0.2;
      // Top-right corner, inset by the same margin on both sides - where a logo usually sits.
      const margin = 0.04;
      const hFrac = (width * ratio * natural.w) / natural.h;
      addLayer({
        id: crypto.randomUUID(),
        kind: "image",
        src,
        name: picked.split(/[\\/]/).pop() ?? "Image",
        width,
        aspect: ratio,
        x: 1 - margin - width / 2,
        y: Math.min(0.5, margin * aspect + hFrac / 2),
        opacity: 1,
        rounded: false,
      });
    } catch (err) {
      setComposeError(String(err));
    }
  };

  // Drag to move (snapping onto the centre lines), drag the corner handle to resize.
  const dragRef = useRef<{ id: string; mode: "move" | "scale"; startX: number; startY: number; orig: ThumbLayer; startDist: number } | null>(null);
  const beginDrag = (e: React.PointerEvent, l: ThumbLayer, mode: "move" | "scale") => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(l.id);
    rootRef.current?.focus();
    const rect = stageRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + l.x * rect.width : 0;
    const cy = rect ? rect.top + l.y * rect.height : 0;
    dragRef.current = { id: l.id, mode, startX: e.clientX, startY: e.clientY, orig: l, startDist: Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy)) };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    if (d.mode === "move") {
      let x = d.orig.x + (e.clientX - d.startX) / rect.width;
      let y = d.orig.y + (e.clientY - d.startY) / rect.height;
      const v = Math.abs(x - 0.5) < SNAP;
      const h = Math.abs(y - 0.5) < SNAP;
      if (v) x = 0.5;
      if (h) y = 0.5;
      setGuides({ v, h });
      updateLayer(d.id, { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
    } else {
      const cx = rect.left + d.orig.x * rect.width;
      const cy = rect.top + d.orig.y * rect.height;
      const factor = Math.hypot(e.clientX - cx, e.clientY - cy) / d.startDist;
      if (d.orig.kind === "text") updateLayer(d.id, { size: Math.max(0.02, Math.min(0.5, d.orig.size * factor)) });
      else updateLayer(d.id, { width: Math.max(0.03, Math.min(1.5, d.orig.width * factor)) });
    }
  };
  const endDrag = () => {
    dragRef.current = null;
    setGuides({ v: false, h: false });
  };

  // ---- save ------------------------------------------------------------------------------------
  const busy = saving || composing;
  const save = async () => {
    if (!choice || busy) return;
    const visible = layers.filter((l) => l.kind === "image" || l.text.trim() !== "");
    if (visible.length === 0) {
      onSave(choice);
      return;
    }
    setComposing(true);
    setComposeError(null);
    try {
      onSave({ kind: "composed", bytes: await composeThumbnail(choice.url, visible) });
    } catch (err) {
      setComposeError(`Couldn't build the thumbnail: ${err}`);
    } finally {
      setComposing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Kept from the player's own shortcuts (arrows seek 5s there, Escape leaves fullscreen).
    e.stopPropagation();
    if (e.key === "Escape") {
      if (selectedId) setSelectedId(null);
      else onCancel();
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      removeLayer(selected.id);
    } else if (e.key.startsWith("Arrow")) {
      if (e.target instanceof HTMLInputElement && e.target.type === "range") return;
      e.preventDefault();
      if (selected) {
        const step = e.shiftKey ? NUDGE * 4 : NUDGE;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        updateLayer(selected.id, { x: Math.max(0, Math.min(1, selected.x + dx)), y: Math.max(0, Math.min(1, selected.y + dy)) });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        stepFrame(e.key === "ArrowLeft" ? -1 : 1);
      }
    }
  };

  const candidates = sprite && sprite.count > 0 && duration > 0 ? Array.from({ length: CANDIDATE_COUNT }, (_, i) => ((i + 0.5) / CANDIDATE_COUNT) * duration) : [];
  const spriteTileStyle = (time: number): React.CSSProperties => {
    if (!sprite) return {};
    const index = Math.min(sprite.count - 1, Math.floor(time / sprite.interval));
    const col = index % sprite.columns;
    const row = Math.floor(index / sprite.columns);
    return {
      backgroundImage: `url("${sprite.url}")`,
      backgroundSize: `${sprite.columns * 100}% ${sprite.rows * 100}%`,
      backgroundPosition: `${sprite.columns > 1 ? (col / (sprite.columns - 1)) * 100 : 0}% ${sprite.rows > 1 ? (row / (sprite.rows - 1)) * 100 : 0}%`,
      aspectRatio: `${sprite.tileWidth} / ${sprite.tileHeight}`,
    };
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const backdropDownRef = useRef(false);
  const hasLayers = layers.length > 0;
  const saveLabel = busy ? "Saving…" : hasLayers ? "Use this thumbnail" : choice?.kind === "image" ? "Use this picture" : "Use this frame";

  const renderPanel = () => {
    if (selected?.kind === "text") {
      const l = selected;
      return (
        <>
          <Section label="Text">
            <textarea
              ref={textInputRef}
              value={l.text}
              rows={2}
              onChange={(e) => updateLayer(l.id, { text: e.target.value })}
              className="w-full resize-none px-2 py-1.5 rounded bg-neutral-950 ring-1 ring-white/10 focus:ring-blue-500 outline-none text-sm text-white"
            />
          </Section>
          <Section label="Font">
            <div className="grid grid-cols-2 gap-1">
              {THUMB_FONTS.map((f) => (
                <Chip key={f.label} active={l.font === f.family} onClick={() => updateLayer(l.id, { font: f.family })} style={{ fontFamily: f.family }}>
                  {f.label}
                </Chip>
              ))}
            </div>
          </Section>
          <Section label="Size">
            <input type="range" min={0.03} max={0.3} step={0.005} value={l.size} onChange={(e) => updateLayer(l.id, { size: Number(e.target.value) })} className="w-full accent-blue-500" />
          </Section>
          <div className="flex flex-wrap gap-1">
            <Chip title="Bold" active={l.bold} onClick={() => updateLayer(l.id, { bold: !l.bold })} className="font-bold">
              B
            </Chip>
            <Chip title="Italic" active={l.italic} onClick={() => updateLayer(l.id, { italic: !l.italic })} className="italic">
              I
            </Chip>
            <Chip title="ALL CAPS" active={l.uppercase} onClick={() => updateLayer(l.id, { uppercase: !l.uppercase })}>
              AA
            </Chip>
            <Chip title="Soft shadow" active={l.shadow} onClick={() => updateLayer(l.id, { shadow: !l.shadow })}>
              Shadow
            </Chip>
            {(["left", "center", "right"] as const).map((a) => (
              <Chip key={a} title={`Align ${a}`} active={l.align === a} onClick={() => updateLayer(l.id, { align: a })}>
                {a === "left" ? <MdFormatAlignLeft size={13} /> : a === "center" ? <MdFormatAlignCenter size={13} /> : <MdFormatAlignRight size={13} />}
              </Chip>
            ))}
          </div>
          <Section label="Colour">
            <SwatchRow value={l.color} onChange={(c) => c && updateLayer(l.id, { color: c })} />
          </Section>
          <Section label="Outline">
            <SwatchRow value={l.outline} allowNone onChange={(c) => updateLayer(l.id, { outline: c })} />
          </Section>
          <Section label="Background">
            <SwatchRow value={l.background} allowNone extra={["rgba(0,0,0,0.72)"]} onChange={(c) => updateLayer(l.id, { background: c })} />
          </Section>
        </>
      );
    }
    if (selected?.kind === "image") {
      const l = selected;
      return (
        <>
          <Section label="Image">
            <p className="text-xs text-neutral-300 truncate" title={l.name}>
              {l.name}
            </p>
          </Section>
          <Section label="Size">
            <input type="range" min={0.03} max={1} step={0.005} value={l.width} onChange={(e) => updateLayer(l.id, { width: Number(e.target.value) })} className="w-full accent-blue-500" />
          </Section>
          <Section label={`Opacity · ${Math.round(l.opacity * 100)}%`}>
            <input type="range" min={0.1} max={1} step={0.01} value={l.opacity} onChange={(e) => updateLayer(l.id, { opacity: Number(e.target.value) })} className="w-full accent-blue-500" />
          </Section>
          <div className="flex gap-1">
            <Chip active={l.rounded} onClick={() => updateLayer(l.id, { rounded: !l.rounded })}>
              Rounded corners
            </Chip>
          </div>
        </>
      );
    }
    return (
      <>
        <Section label="Add text">
          <div className="grid grid-cols-2 gap-1.5">
            {TEXT_PRESETS.map((p) => {
              const sample = p.make();
              return (
                <button
                  key={p.label}
                  type="button"
                  title={p.hint}
                  onClick={() => addLayer(p.make())}
                  className="h-14 rounded-md bg-gradient-to-br from-neutral-700 to-neutral-800 ring-1 ring-white/10 hover:ring-blue-400 flex items-center justify-center overflow-hidden"
                >
                  <span style={{ ...textBoxStyle(sample, 0), fontSize: 13, padding: sample.background ? "2px 6px" : 0, borderRadius: 4, WebkitTextStroke: sample.outline ? `1.5px ${sample.outline}` : undefined, textShadow: undefined }}>
                    {p.label}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
        <button
          type="button"
          onClick={() => void addLogo()}
          className="flex items-center justify-center gap-1.5 h-9 rounded-md text-xs text-neutral-200 bg-white/[0.06] hover:bg-white/10 ring-1 ring-white/10"
        >
          <IoImageOutline size={14} /> Add logo or image…
        </button>
        {hasLayers && (
          <Section label="Layers">
            <div className="flex flex-col gap-0.5">
              {[...layers].reverse().map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelectedId(l.id)}
                  className="flex items-center gap-1.5 px-2 h-7 rounded text-xs text-neutral-300 hover:bg-white/10 text-left"
                >
                  {l.kind === "text" ? <IoText size={12} /> : <IoImageOutline size={12} />}
                  <span className="truncate">{l.kind === "text" ? shownTextOf(l) || "(empty text)" : l.name}</span>
                </button>
              ))}
            </div>
          </Section>
        )}
        <p className="text-[11px] leading-snug text-neutral-500">
          Drag to move, pull the corner to resize. Layers stay where they are while you try other frames.
        </p>
      </>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 p-4"
      onClick={(e) => {
        stop(e);
        // Only a click that also STARTED on the backdrop - releasing a layer drag out here must
        // never throw the work away.
        if (!busy && backdropDownRef.current && e.target === e.currentTarget) onCancel();
        backdropDownRef.current = false;
      }}
      onPointerDown={(e) => {
        stop(e);
        backdropDownRef.current = e.target === e.currentTarget;
      }}
      onDoubleClick={stop}
      onWheel={stop}
      onContextMenu={stop}
    >
      <div
        ref={rootRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col gap-3 p-4 rounded-xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl outline-none w-[min(1180px,96vw)] max-h-[96vh] text-white"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Set thumbnail</span>
          <div className="flex items-center gap-3">
            <span className="text-neutral-400 text-xs">
              {choice?.kind === "image" ? "Picture from your computer" : choice ? `Frame at ${formatTime(choice.time)}` : ""}
            </span>
            <button type="button" title="Close (Esc)" onClick={onCancel} disabled={busy} className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10">
              <IoClose size={16} />
            </button>
          </div>
        </div>

        <div className="flex gap-4 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <div ref={stageBoxRef} className="h-[min(56vh,560px)] flex items-center justify-center rounded-lg bg-black ring-1 ring-white/10">
              {choice ? (
                <div
                  ref={stageRef}
                  className="relative overflow-hidden select-none"
                  style={{ width: stageW, height: stageH }}
                  onPointerDown={() => setSelectedId(null)}
                >
                  <img
                    src={choice.url}
                    alt="Thumbnail"
                    draggable={false}
                    onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 16, h: e.currentTarget.naturalHeight || 9 })}
                    className="absolute inset-0 w-full h-full"
                  />
                  {guides.v && <div className="absolute inset-y-0 left-1/2 w-px bg-fuchsia-400/90 pointer-events-none" />}
                  {guides.h && <div className="absolute inset-x-0 top-1/2 h-px bg-fuchsia-400/90 pointer-events-none" />}
                  {layers.map((l) => {
                    const isSel = l.id === selectedId;
                    const common = {
                      onPointerDown: (e: React.PointerEvent) => beginDrag(e, l, "move"),
                      onPointerMove: onDragMove,
                      onPointerUp: endDrag,
                      onPointerCancel: endDrag,
                    };
                    const handle = isSel && (
                      <span
                        title="Drag to resize"
                        onPointerDown={(e) => beginDrag(e, l, "scale")}
                        onPointerMove={onDragMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-sm bg-white ring-2 ring-blue-500 cursor-nwse-resize"
                      />
                    );
                    if (l.kind === "text") {
                      return (
                        <div
                          key={l.id}
                          {...common}
                          onDoubleClick={() => requestAnimationFrame(() => textInputRef.current?.select())}
                          className={`absolute cursor-move ${isSel ? "outline outline-2 outline-blue-500 outline-offset-2" : "hover:outline hover:outline-1 hover:outline-white/50 hover:outline-offset-2"}`}
                          style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, transform: "translate(-50%, -50%)", ...textBoxStyle(l, stageH) }}
                        >
                          {shownTextOf(l) || " "}
                          {handle}
                        </div>
                      );
                    }
                    const w = l.width * stageW;
                    return (
                      <div
                        key={l.id}
                        {...common}
                        className={`absolute cursor-move ${isSel ? "outline outline-2 outline-blue-500 outline-offset-2" : "hover:outline hover:outline-1 hover:outline-white/50 hover:outline-offset-2"}`}
                        style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: w, height: w * l.aspect, transform: "translate(-50%, -50%)" }}
                      >
                        <img
                          src={l.src}
                          alt={l.name}
                          draggable={false}
                          className="w-full h-full"
                          style={{ opacity: l.opacity, borderRadius: l.rounded ? imageRadiusFraction * w : undefined }}
                        />
                        {handle}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className="text-neutral-500 text-xs">No frame yet</span>
              )}
            </div>

            {duration > 0 && (
              <div className="flex items-center gap-2">
                <button type="button" title="Previous frame (←)" onClick={() => stepFrame(-1)} className="p-1.5 rounded text-neutral-300 hover:bg-white/10">
                  <IoChevronBack size={14} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={FRAME_STEP}
                  value={scrubTime}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  className="flex-1 accent-red-500"
                  aria-label="Pick a frame"
                />
                <button type="button" title="Next frame (→)" onClick={() => stepFrame(1)} className="p-1.5 rounded text-neutral-300 hover:bg-white/10">
                  <IoChevronForward size={14} />
                </button>
                <span className="w-16 text-right text-[11px] tabular-nums text-neutral-400">{formatTime(scrubTime)}</span>
              </div>
            )}

            {candidates.length > 0 && (
              <div className="grid grid-cols-10 gap-1">
                {candidates.map((t) => (
                  <button
                    key={t}
                    type="button"
                    title={`Jump to ${formatTime(t)}`}
                    onClick={() => seekTo(t)}
                    className="rounded overflow-hidden ring-1 ring-white/10 hover:ring-red-400 bg-neutral-800"
                    style={spriteTileStyle(t)}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void chooseImage()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-neutral-200 bg-white/[0.06] hover:bg-white/10"
              >
                <IoImageOutline size={14} /> Use a picture instead…
              </button>
              {choice?.kind === "image" && (
                <button
                  type="button"
                  onClick={() => seekTo(scrubTime)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-neutral-200 bg-white/[0.06] hover:bg-white/10"
                >
                  <IoFilmOutline size={14} /> Use a frame instead
                </button>
              )}
              <p className="flex-1 min-w-[180px] text-neutral-500 text-[11px] leading-snug">
                {embedsInFile
                  ? "Saved into the video file itself, so it's also what File Explorer and shared copies show."
                  : "Saved in Briefcast. This file type can't hold a thumbnail of its own, so the file itself is left untouched."}
              </p>
            </div>
          </div>

          <div className="w-64 shrink-0 flex flex-col gap-3 overflow-y-auto pr-0.5 max-h-[calc(96vh-140px)]">
            {selected && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setSelectedId(null)} className="flex items-center gap-1 px-2 h-7 rounded text-xs text-neutral-300 hover:bg-white/10">
                  <IoChevronBack size={12} /> Done
                </button>
                <span className="flex-1" />
                <button type="button" title="Duplicate" onClick={() => duplicateLayer(selected)} className="p-1.5 rounded text-neutral-300 hover:bg-white/10">
                  <IoCopyOutline size={14} />
                </button>
                <button type="button" title="Delete (Del)" onClick={() => removeLayer(selected.id)} className="p-1.5 rounded text-red-400 hover:bg-red-500/10">
                  <IoTrashOutline size={14} />
                </button>
              </div>
            )}
            {renderPanel()}
          </div>
        </div>

        {(error || composeError) && <p className="text-red-400 text-xs leading-snug">{composeError ?? error}</p>}

        <div className="flex items-center justify-end gap-2">
          {onShareCopyChange ? (
            <label
              className="mr-auto flex items-center gap-2 text-xs text-neutral-300 cursor-pointer select-none"
              title="WhatsApp, Telegram and Instagram ignore a video's thumbnail and show its first frame. This also saves a copy that opens on your thumbnail."
            >
              <input type="checkbox" checked={!!shareCopy} onChange={(e) => onShareCopyChange(e.target.checked)} className="accent-blue-500" />
              Also make a share-ready copy <span className="text-neutral-500">(WhatsApp, Telegram…)</span>
            </label>
          ) : (
            <span className="mr-auto text-[11px] text-neutral-500">Enter saves · Esc closes</span>
          )}
          <button type="button" className="px-3.5 py-1.5 rounded-md text-sm text-neutral-300 hover:bg-white/10" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            onClick={() => void save()}
            disabled={busy || !choice}
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ThumbnailPicker;
