// components/video/NewVideoProjectDialog.tsx
//
// The Video Editor's "Create video" dialog - builds a new video project (services/video_edits.rs)
// out of still images: pick photos from the library and/or anywhere on disk, put them in order,
// choose a frame shape, pace, motion, transition style and look, and the editor opens on a timeline
// with one clip per image. Picking nothing starts a blank timeline instead, to fill by dropping media
// on it. Everything chosen here is only a starting point - every clip stays fully editable
// afterwards, and music/text/overlays are added in the editor.
//
// The stage on the right plays the video as it will come out: each picture letterboxed into the
// frame as export fits it, the same Ken Burns windows (kenBurnsWindow), transitions drawn by the
// same renderer as the editor's preview (transitionCanvas.ts) and the look through the same
// per-pixel function the grade LUT bakes (gradeLooks.ts).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoAdd, IoCheckmark, IoClose, IoFolderOpenOutline, IoImageOutline, IoPause, IoPlay, IoSparkles } from "react-icons/io5";
import { thumbnailLimiter } from "../../utils/concurrencyLimiter";
import {
  DEFAULT_IMAGE_CLIP_SECONDS,
  GradeLookName,
  IMAGE_CLIP_EXTENSIONS,
  KenBurnsPreset,
  NewProjectOptions,
  TransitionType,
  VideoProjectFrame,
  projectTransitionSeconds,
} from "../../utils/videoEditTypes";
import { kenBurnsWindow } from "../../utils/videoColorFilters";
import { GRADE_LOOKS, applyLook } from "../../utils/gradeLooks";
import { drawCanvasTransition, isCanvasTransition } from "./transitionCanvas";

export interface NewVideoProjectRequest {
  name: string;
  frame: VideoProjectFrame;
  imagePaths: string[];
  options: NewProjectOptions;
}

interface NewVideoProjectDialogProps {
  // Every still image in the library that can become a clip (isImageClipPath).
  libraryImages: { name: string; path: string }[];
  // Dashboard's resolveImageThumbnailUrl - small cached thumbnails, works for any path on disk.
  resolveThumbnailUrl: (file: { name: string; path: string }) => Promise<string>;
  // Rejects with a message to show in place (the dialog stays open on failure).
  onCreate: (request: NewVideoProjectRequest) => Promise<void>;
  onClose: () => void;
}

const FRAME_PRESETS: { id: string; label: string; hint: string; frame: VideoProjectFrame }[] = [
  { id: "landscape", label: "Landscape", hint: "16:9", frame: { width: 1920, height: 1080 } },
  { id: "portrait", label: "Portrait", hint: "9:16", frame: { width: 1080, height: 1920 } },
  { id: "square", label: "Square", hint: "1:1", frame: { width: 1080, height: 1080 } },
  { id: "classic", label: "Classic", hint: "4:3", frame: { width: 1440, height: 1080 } },
];

// Transition styles offered here - each drawn exactly by the stage. "mix" cycles MIX_CYCLE.
type StyleId = "none" | "fade" | "mix" | TransitionType;
const MIX_CYCLE: TransitionType[] = ["push", "cube", "slice", "tiles", "strips", "spin", "split", "beam"];
const TRANSITION_STYLES: { id: StyleId; label: string }[] = [
  { id: "mix", label: "Mix" },
  { id: "fade", label: "Crossfade" },
  { id: "push", label: "Push" },
  { id: "cube", label: "Cube" },
  { id: "tiles", label: "Tile wall" },
  { id: "slice", label: "Slice" },
  { id: "strips", label: "Strips" },
  { id: "split", label: "Split" },
  { id: "spin", label: "Spin" },
  { id: "flip", label: "Flip" },
  { id: "beam", label: "Light beam" },
  { id: "glitch", label: "Glitch" },
  { id: "blocks", label: "Blocks" },
  { id: "none", label: "Cut" },
];

const DURATION_CHOICES = [1.5, 2.5, 3, 5, 8];
const KEN_BURNS_CYCLE: KenBurnsPreset[] = ["zoom-in", "zoom-out", "pan-right", "pan-left"];
// The stage plays at most this long per picture, so a slow slideshow still shows its style.
const STAGE_MAX_SECONDS = 2.6;

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const formatLength = (seconds: number) => {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

// ---------- the stage ----------

// A picture letterboxed into a w x h frame on black (export's frame_fit_chain), through the look.
function fittedFrame(img: HTMLImageElement, w: number, h: number, look: GradeLookName | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: !!look })!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  if (look) {
    // A picture the browser won't let us read back just plays without the look on the stage.
    try {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = applyLook(look, 0.85, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
        px[i] = r * 255;
        px[i + 1] = g * 255;
        px[i + 2] = b * 255;
      }
      ctx.putImageData(data, 0, 0);
    } catch (err) {
      console.warn("Look preview unavailable for this picture", err);
    }
  }
  return canvas;
}

interface StageProps {
  urls: string[];
  frame: VideoProjectFrame;
  imageSeconds: number;
  kenBurns: boolean;
  style: StyleId;
  look: GradeLookName | null;
  playing: boolean;
  // Restarts the loop just before a transition (a style being tried out).
  restartKey: string;
}

const Stage: React.FC<StageProps> = ({ urls, frame, imageSeconds, kenBurns, style, look, playing, restartKey }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [box, setBox] = useState({ w: 320, h: 320 });

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      urls.map(
        (url) =>
          new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            // Read back for the look (asset URLs serve CORS headers, as the player's frames do).
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
          })
      )
    ).then((loaded) => !cancelled && setImages(loaded.filter((i): i is HTMLImageElement => !!i)));
    return () => {
      cancelled = true;
    };
  }, [urls]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The frame on screen, as large as fits the stage.
  const scale = Math.min(box.w / frame.width, box.h / frame.height);
  const W = Math.max(2, Math.floor(frame.width * scale));
  const H = Math.max(2, Math.floor(frame.height * scale));

  const frames = useMemo(() => {
    const dpr = window.devicePixelRatio || 1;
    return images.map((img) => fittedFrame(img, Math.round(W * dpr), Math.round(H * dpr), look));
  }, [images, W, H, look]);

  const clockRef = useRef({ base: performance.now(), offset: 0 });
  const per = Math.min(imageSeconds, STAGE_MAX_SECONDS);
  const tr = projectTransitionSeconds(per);
  useEffect(() => {
    // Start a beat before the second picture comes in, so a new style shows straight away.
    clockRef.current = { base: performance.now(), offset: frames.length > 1 ? Math.max(0, per - 0.6) : 0 };
  }, [restartKey, frames.length, per]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pics = [document.createElement("canvas"), document.createElement("canvas")];
    pics.forEach((p) => {
      p.width = canvas.width;
      p.height = canvas.height;
    });
    // Picture i at `progress` through its own clip, with its Ken Burns window.
    const picture = (into: HTMLCanvasElement, i: number, progress: number) => {
      const pctx = into.getContext("2d")!;
      const src = frames[i];
      const win = kenBurns ? kenBurnsWindow({ preset: KEN_BURNS_CYCLE[i % KEN_BURNS_CYCLE.length], intensity: 0.5 }, progress, per) : null;
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      if (!win) {
        pctx.drawImage(src, 0, 0);
        return;
      }
      const sw = src.width / win.zoom;
      const sh = src.height / win.zoom;
      pctx.drawImage(src, win.cx * src.width - sw / 2, win.cy * src.height - sh / 2, sw, sh, 0, 0, into.width, into.height);
    };
    const styleFor = (i: number): StyleId => (style === "mix" ? MIX_CYCLE[(i - 1) % MIX_CYCLE.length] : style);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (playing) clockRef.current.offset += (now - last) / 1000;
      last = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!frames.length) return;
      const total = frames.length * per;
      const t = clockRef.current.offset % total;
      const i = Math.min(frames.length - 1, Math.floor(t / per));
      const local = t - i * per;
      picture(pics[1], i, local / per);
      const s = styleFor(i);
      if (i === 0 || s === "none" || local >= tr) {
        ctx.drawImage(pics[1], 0, 0);
        return;
      }
      const p = local / tr;
      // Stills hold their last frame through the transition, as export does.
      picture(pics[0], i - 1, 1);
      if (s === "fade") {
        ctx.drawImage(pics[0], 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(pics[1], 0, 0);
        ctx.globalAlpha = 1;
      } else if (s !== "mix" && isCanvasTransition(s)) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCanvasTransition(ctx, s, {}, p, { old: pics[0], next: pics[1] }, W, H, dpr);
      } else ctx.drawImage(pics[1], 0, 0);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frames, W, H, kenBurns, style, playing, per, tr]);

  return (
    <div ref={boxRef} className="absolute inset-0 flex items-center justify-center">
      <canvas ref={canvasRef} style={{ width: W, height: H }} className="rounded-md shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" />
    </div>
  );
};

// ---------- small controls ----------

const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);

const Pill: React.FC<{ active: boolean; onClick: () => void; onHover?: (on: boolean) => void; children: React.ReactNode; title?: string }> = ({ active, onClick, onHover, children, title }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    onMouseEnter={() => onHover?.(true)}
    onMouseLeave={() => onHover?.(false)}
    className={`h-8 px-3 rounded-full text-[12.5px] font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
      active
        ? "bg-neutral-900 text-white shadow-sm dark:bg-white dark:text-neutral-900"
        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-white/[0.06] dark:text-neutral-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
    }`}
  >
    {children}
  </button>
);

const Switch: React.FC<{ on: boolean; onChange: (on: boolean) => void; label: string; hint: string }> = ({ on, onChange, label, hint }) => (
  <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex items-center gap-3 text-left outline-none group">
    <span className="flex-1 min-w-0">
      <span className="block text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{label}</span>
      <span className="block text-[11.5px] text-neutral-500 dark:text-neutral-400">{hint}</span>
    </span>
    <span className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-neutral-300 dark:bg-neutral-700"}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  </button>
);

// ---------- the dialog ----------

const NewVideoProjectDialog: React.FC<NewVideoProjectDialogProps> = ({ libraryImages, resolveThumbnailUrl, onCreate, onClose }) => {
  const [name, setName] = useState("Untitled video");
  const [frameId, setFrameId] = useState(FRAME_PRESETS[0].id);
  // In clip order - the order images were picked in, rearranged by dragging in the sequence strip.
  const [picked, setPicked] = useState<string[]>([]);
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_CLIP_SECONDS);
  const [kenBurns, setKenBurns] = useState(true);
  const [style, setStyle] = useState<StyleId>("mix");
  const [hoverStyle, setHoverStyle] = useState<StyleId | null>(null);
  const [look, setLook] = useState<GradeLookName | null>(null);
  const [playing, setPlaying] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isCreating) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, isCreating]);

  // Library images plus anything picked from disk, de-duplicated - every tile either list shows.
  const thumbnailPaths = useMemo(() => Array.from(new Set([...picked, ...libraryImages.map((image) => image.path)])), [picked, libraryImages]);
  useEffect(() => {
    let cancelled = false;
    thumbnailPaths
      .filter((path) => !thumbUrls[path])
      .forEach((path) => {
        thumbnailLimiter(() => resolveThumbnailUrl({ name: baseName(path), path }))
          .then((url) => !cancelled && setThumbUrls((prev) => (prev[path] ? prev : { ...prev, [path]: url })))
          .catch((err) => console.error("Failed to resolve thumbnail for", path, err));
      });
    return () => {
      cancelled = true;
    };
    // thumbUrls deliberately left out - same reasoning as VideoEditorHome's own thumbnail effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnailPaths, resolveThumbnailUrl]);

  const togglePicked = (path: string) => setPicked((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  const moveTo = (from: number, to: number) =>
    setPicked((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  const handleBrowse = async () => {
    const selected = await openFileDialog({ multiple: true, filters: [{ name: "Images", extensions: IMAGE_CLIP_EXTENSIONS }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setPicked((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]);
  };

  const frame = FRAME_PRESETS.find((preset) => preset.id === frameId)?.frame ?? FRAME_PRESETS[0].frame;

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim() || "Untitled video",
        frame,
        imagePaths: picked,
        options: {
          imageDuration,
          kenBurns,
          transition: style === "none" || style === "mix" ? null : style === "fade" ? "fade" : style,
          ...(style === "mix" ? { transitionCycle: MIX_CYCLE } : {}),
          ...(look ? { look } : {}),
        },
      });
    } catch (err) {
      setError(`Couldn't create the video: ${err instanceof Error ? err.message : err}`);
      setIsCreating(false);
    }
  };

  // What the stage plays: the picks, or a few library pictures as a taste of the style.
  const stagePaths = picked.length ? picked : libraryImages.slice(0, 4).map((i) => i.path);
  const stageUrls = useMemo(() => stagePaths.map((p) => thumbUrls[p]).filter((u): u is string => !!u), [stagePaths.join("|"), thumbUrls]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownStyle = hoverStyle ?? style;

  const renderThumb = (path: string) =>
    thumbUrls[path] ? (
      <img src={thumbUrls[path]} alt="" className="w-full h-full object-cover" draggable={false} />
    ) : (
      <IoImageOutline size={20} className="text-neutral-300 dark:text-neutral-600" />
    );

  const totalSeconds = picked.length * imageDuration;
  const allPicked = libraryImages.length > 0 && libraryImages.every((i) => picked.includes(i.path));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/50 backdrop-blur-sm p-4 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && !isCreating && onClose()}
    >
      <div
        role="dialog"
        aria-labelledby="new-video-project-title"
        className="w-full max-w-6xl h-full max-h-[880px] flex flex-col overflow-hidden rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 h-16 shrink-0 border-b border-neutral-100 dark:border-white/[0.06]">
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 text-white flex items-center justify-center shadow-sm">
            <IoSparkles size={17} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id="new-video-project-title" className="text-[15px] font-semibold text-neutral-900 dark:text-white leading-tight">
              Create a video
            </h2>
            <p className="text-[12px] text-neutral-500 dark:text-neutral-400">Pick photos, choose a style - see it play before you start editing.</p>
          </div>
          <button type="button" onClick={onClose} disabled={isCreating} aria-label="Close" className="p-2 -mr-2 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          {/* Media */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-6 pt-4 pb-3">
              <h3 className="text-[13px] font-semibold text-neutral-900 dark:text-white">Your photos</h3>
              <span className="text-[12px] text-neutral-400 tabular-nums">{libraryImages.length}</span>
              <span className="flex-1" />
              {libraryImages.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPicked(allPicked ? [] : [...picked, ...libraryImages.map((i) => i.path).filter((p) => !picked.includes(p))])}
                  className="h-8 px-3 rounded-full text-[12.5px] font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/[0.08]"
                >
                  {allPicked ? "Clear all" : "Select all"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:text-blue-300 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 outline-none"
              >
                <IoFolderOpenOutline size={14} />
                Add from computer
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
              {libraryImages.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2.5 p-1.5 -mx-1.5">
                  {libraryImages.map((image) => {
                    const order = picked.indexOf(image.path);
                    const on = order >= 0;
                    return (
                      <button
                        key={image.path}
                        type="button"
                        onClick={() => togglePicked(image.path)}
                        title={image.name}
                        className={`group relative aspect-square rounded-xl overflow-hidden bg-neutral-100 dark:bg-white/[0.04] flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-all ${
                          on ? "ring-[3px] ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900" : ""
                        }`}
                      >
                        <span className={`absolute inset-0 transition-transform duration-300 ${on ? "scale-[0.97]" : "group-hover:scale-105"}`}>
                          <span className="absolute inset-0 flex items-center justify-center">{renderThumb(image.path)}</span>
                        </span>
                        <span className={`absolute inset-0 transition-colors ${on ? "bg-blue-500/15" : "bg-black/0 group-hover:bg-black/10"}`} />
                        <span
                          className={`absolute top-2 right-2 min-w-[22px] h-[22px] px-1 rounded-full text-[11px] font-semibold flex items-center justify-center tabular-nums transition-all ${
                            on ? "bg-blue-500 text-white shadow" : "bg-black/25 text-transparent ring-1 ring-white/80 opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          {on ? order + 1 : <IoCheckmark size={12} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleBrowse()}
                  className="w-full h-full min-h-[220px] rounded-2xl border-2 border-dashed border-neutral-200 dark:border-white/10 flex flex-col items-center justify-center gap-2 text-neutral-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                >
                  <IoImageOutline size={30} />
                  <span className="text-[13px] font-medium">Choose photos from your computer</span>
                  <span className="text-[12px]">Or start blank and drop media on the timeline</span>
                </button>
              )}
            </div>

            {/* Sequence */}
            <div className="shrink-0 border-t border-neutral-100 dark:border-white/[0.06] px-6 py-3">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">Sequence</h3>
                {picked.length > 0 && (
                  <span className="text-[12px] text-neutral-400 tabular-nums">
                    {picked.length} {picked.length === 1 ? "photo" : "photos"} · {formatLength(totalSeconds)} · drag to reorder
                  </span>
                )}
              </div>
              {picked.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {picked.map((path, i) => (
                    <div
                      key={path}
                      draggable
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragIndex !== null && dragIndex !== i) {
                          moveTo(dragIndex, i);
                          setDragIndex(i);
                        }
                      }}
                      onDragEnd={() => setDragIndex(null)}
                      className={`group relative shrink-0 w-24 aspect-video rounded-lg overflow-hidden bg-neutral-100 dark:bg-white/[0.04] cursor-grab active:cursor-grabbing flex items-center justify-center transition-opacity ${
                        dragIndex === i ? "opacity-40" : ""
                      }`}
                    >
                      {renderThumb(path)}
                      <span className="absolute bottom-1 left-1 px-1.5 rounded-md bg-black/60 text-[10px] font-semibold text-white tabular-nums">{i + 1}</span>
                      <button
                        type="button"
                        onClick={() => togglePicked(path)}
                        aria-label="Remove"
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <IoClose size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="h-[54px] flex items-center text-[12.5px] text-neutral-500 dark:text-neutral-400">
                  Tap photos to add them - they play in the order you pick. Pick nothing to start with a blank timeline.
                </p>
              )}
            </div>
          </div>

          {/* Style + stage */}
          <aside className="w-full lg:w-[380px] shrink-0 min-h-0 flex flex-col border-t lg:border-t-0 lg:border-l border-neutral-100 dark:border-white/[0.06] bg-neutral-50/70 dark:bg-white/[0.02]">
            <div className="relative shrink-0 h-[290px] m-4 mb-0 rounded-2xl bg-neutral-950 overflow-hidden ring-1 ring-black/5 dark:ring-white/[0.07]">
              <div className="absolute inset-3 bottom-12">
                {stageUrls.length ? (
                  <Stage urls={stageUrls} frame={frame} imageSeconds={imageDuration} kenBurns={kenBurns} style={shownStyle} look={look} playing={playing} restartKey={`${shownStyle}|${frameId}`} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/40">Your preview plays here</div>
                )}
              </div>
              <div className="absolute left-3 right-3 bottom-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPlaying((p) => !p)}
                  aria-label={playing ? "Pause preview" : "Play preview"}
                  className="w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 text-white backdrop-blur flex items-center justify-center"
                >
                  {playing ? <IoPause size={14} /> : <IoPlay size={14} className="translate-x-[1px]" />}
                </button>
                {!picked.length && stageUrls.length > 0 && <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10.5px] text-white/70">Sample</span>}
                <span className="flex-1" />
                <span className="text-[11px] text-white/55 truncate">
                  {TRANSITION_STYLES.find((t) => t.id === shownStyle)?.label}
                  {look ? ` · ${GRADE_LOOKS.find((l) => l.value === look)?.label}` : ""}
                </span>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
              <Section title="Name">
                <input
                  id="new-video-project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  className="w-full h-10 px-3 rounded-xl text-[13.5px] bg-white dark:bg-neutral-950 ring-1 ring-neutral-200 dark:ring-white/10 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </Section>

              <Section title="Format">
                <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-neutral-100 dark:bg-white/[0.05]">
                  {FRAME_PRESETS.map((preset) => {
                    const active = preset.id === frameId;
                    const s = 16 / Math.max(preset.frame.width, preset.frame.height);
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setFrameId(preset.id)}
                        title={`${preset.label} (${preset.frame.width}×${preset.frame.height})`}
                        className={`flex flex-col items-center gap-1 py-1.5 rounded-lg text-[11px] font-medium transition-all outline-none ${
                          active ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-sm" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                        }`}
                      >
                        <span className="h-5 flex items-center">
                          <span className={`block rounded-[3px] border-[1.5px] ${active ? "border-blue-500 bg-blue-500/10" : "border-current"}`} style={{ width: preset.frame.width * s, height: preset.frame.height * s }} />
                        </span>
                        {preset.hint}
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section title="Each photo" aside={<span className="text-[12px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200">{imageDuration}s</span>}>
                <input
                  type="range"
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={imageDuration}
                  onChange={(e) => setImageDuration(Number(e.target.value))}
                  className="w-full accent-blue-600"
                  aria-label="Seconds per photo"
                />
                <div className="flex gap-1.5">
                  {DURATION_CHOICES.map((d) => (
                    <Pill key={d} active={imageDuration === d} onClick={() => setImageDuration(d)}>
                      {d}s
                    </Pill>
                  ))}
                </div>
              </Section>

              <Switch on={kenBurns} onChange={setKenBurns} label="Slow zoom & pan" hint="Gentle camera motion on every photo" />

              <Section title="Transitions">
                <div className="flex flex-wrap gap-1.5" onMouseLeave={() => setHoverStyle(null)}>
                  {TRANSITION_STYLES.map((t) => (
                    <Pill
                      key={t.id}
                      active={style === t.id}
                      onClick={() => setStyle(t.id)}
                      onHover={(on) => setHoverStyle(on ? t.id : null)}
                      title={t.id === "mix" ? "A different transition each time - push, cube, slice, tile wall..." : undefined}
                    >
                      {t.id === "mix" ? (
                        <span className="flex items-center gap-1">
                          <IoSparkles size={12} /> Mix
                        </span>
                      ) : (
                        t.label
                      )}
                    </Pill>
                  ))}
                </div>
              </Section>

              <Section title="Look">
                <div className="flex flex-wrap gap-1.5">
                  <Pill active={look === null} onClick={() => setLook(null)}>
                    Natural
                  </Pill>
                  {GRADE_LOOKS.map((l) => (
                    <Pill key={l.value} active={look === l.value} onClick={() => setLook(l.value)} title={l.title}>
                      {l.label}
                    </Pill>
                  ))}
                </div>
              </Section>
            </div>
          </aside>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-6 h-16 shrink-0 border-t border-neutral-100 dark:border-white/[0.06]">
          <p className="flex-1 min-w-0 text-[12.5px] text-neutral-500 dark:text-neutral-400 truncate">
            {error ? (
              <span className="text-red-600 dark:text-red-400">{error}</span>
            ) : picked.length > 0 ? (
              `About ${formatLength(totalSeconds)} long - add music, text and overlays in the editor.`
            ) : (
              "Starts as an empty timeline."
            )}
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="h-10 px-4 rounded-xl text-[13.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/10 outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={isCreating}
            className="flex items-center gap-1.5 h-10 px-5 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 text-white text-[13.5px] font-semibold shadow-md shadow-blue-600/25 hover:brightness-110 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
          >
            <IoAdd size={17} />
            {isCreating ? "Creating…" : picked.length > 0 ? "Create video" : "Start blank"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewVideoProjectDialog;
