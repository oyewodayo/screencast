// components/video/NewVideoProjectDialog.tsx
//
// The Video Editor's "Create video" dialog - builds a new video project (services/video_edits.rs)
// out of still images: pick photos from the library and/or anywhere on disk, put them in order,
// pick a style template (videoStyleTemplates.ts - Event Recap, Film Strip, New Collection...) or
// set pace, motion, transition and look by hand, change the template's words, add a song, and the
// editor opens on the finished edit - cut on the song's beats, with the template's captions,
// collages and frame overlays. Picking nothing starts a blank timeline instead, to fill by dropping
// media on it. Everything chosen here is only a starting point - every clip, caption and overlay
// stays fully editable afterwards.
//
// The stage on the right plays the very project the editor will open with (buildStyledProject,
// drawn by ProjectStage) - in time with the song's preview when there is one.
import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoAdd,
  IoCheckmark,
  IoClose,
  IoFolderOpenOutline,
  IoImageOutline,
  IoMusicalNotes,
  IoVideocam,
  IoPause,
  IoPlay,
  IoSearch,
  IoShuffle,
  IoSparkles,
  IoVolumeHighOutline,
  IoVolumeMuteOutline,
} from "react-icons/io5";
import { createLimiter, thumbnailLimiter } from "../../utils/concurrencyLimiter";
import { DEFAULT_IMAGE_CLIP_SECONDS, GradeLookName, IMAGE_CLIP_EXTENSIONS, KenBurnsPreset, NewProjectOptions, TransitionType, VideoEditState, VideoProjectFrame } from "../../utils/videoEditTypes";
import { GRADE_LOOKS } from "../../utils/gradeLooks";
import { assetEntry } from "../../utils/videoAssets";
import { CLIP_FX } from "../../utils/clipFx";
import { fetchMusicCatalog, getTrackFile, libraryInfoOf, MusicTrack } from "../../utils/musicLibrary";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import { trackEvent } from "../../utils/telemetry";
import { TITLE_FONTS, loadTitleFonts, titleFontCss } from "../../utils/titleFonts";
import { titleStyle } from "../../utils/titleStyles";
import {
  MONTAGE_MUSIC,
  MeasureText,
  STYLE_TEMPLATES,
  StyleTemplate,
  StyledProjectMusic,
  StyledProjectOptions,
  buildStyledProject,
  musicStartFor,
  photoSecondsAt,
  styleTemplate,
  suggestTemplateTracks,
  templateTexts,
} from "../../utils/videoStyleTemplates";
import ProjectStage, { StagePicture } from "./ProjectStage";
import TitleLookTile from "./TitleLookTile";
import { photoFillPath } from "../../utils/photoFill";
import { BRAND_INTROS, BrandIntroStyle, BrandOptions, VideoInfo } from "../../utils/videoStyleTemplates";
import { getFileCategory } from "../../utils/fileCategory";
import { useBatchedRecord } from "../../hooks/useBatchedRecord";
import { buildMediaIndex, searchMedia } from "../../utils/mediaSearch";

export interface NewVideoProjectRequest {
  name: string;
  frame: VideoProjectFrame;
  imagePaths: string[];
  options: NewProjectOptions;
  // The finished project, built here (buildStyledProject) - absent for a blank timeline.
  state?: VideoEditState;
}

interface NewVideoProjectDialogProps {
  // Every still image in the library that can become a clip (isImageClipPath), and every video.
  libraryImages: { name: string; path: string }[];
  libraryVideos: { name: string; path: string }[];
  // Dashboard's resolveImageThumbnailUrl / resolveVideoThumbnailUrl - small cached thumbnails,
  // work for any path on disk.
  resolveThumbnailUrl: (file: { name: string; path: string }) => Promise<string>;
  resolveVideoThumbnailUrl: (file: { name: string; path: string }) => Promise<string>;
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

// Transition choices. "mix" cycles MIX_CYCLE; "template" the picked style's own cycle.
type StyleId = "none" | "fade" | "mix" | "template" | TransitionType;
const MIX_CYCLE: TransitionType[] = ["push", "cube", "slice", "tiles", "strips", "spin", "split", "beam"];
const TRANSITION_STYLES: { id: StyleId; label: string }[] = [
  { id: "mix", label: "Mix" },
  { id: "fade", label: "Crossfade" },
  { id: "zoomblur", label: "Zoom blur" },
  { id: "whip", label: "Whip" },
  { id: "fadewhite", label: "Flash" },
  { id: "lightleak", label: "Light leak" },
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
  { id: "pagecurl", label: "Page curl" },
  { id: "none", label: "Cut" },
];

const DURATION_CHOICES = [1.5, 2.5, 3, 5, 8];
const BEAT_CHOICES = [1, 2, 4, 8];
const KEN_BURNS_CYCLE: KenBurnsPreset[] = ["zoom-in", "zoom-out", "pan-right", "pan-left"];
// The stage plays at most this many photos - enough to show every part of a style.
const STAGE_MAX_PHOTOS = 16;
// Stage pictures are scaled down to this on their long side once decoded - two at a time, on
// their own queue so the photo grid's thumbnails never wait behind them.
const STAGE_PICTURE_PX = 1280;
const stagePictureLimiter = createLimiter(2);

type MusicPick =
  | { kind: "library"; track: MusicTrack }
  | { kind: "file"; path: string; name: string; duration: number; bpm?: number; beats?: number[] };
interface TrackBeats {
  bpm: number;
  beats: number[];
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const isVideoPath = (path: string): boolean => getFileCategory(baseName(path)) === "video";
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm", "wmv"];

// The brand kit is remembered on this computer between videos (a convenience - nothing depends on it).
const BRAND_KEY = "briefcast.brandKit";
const EMPTY_BRAND: BrandOptions = { name: "", tagline: "", website: "", logo: null, intro: null, outro: false, bar: false };
function readBrand(): BrandOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(BRAND_KEY) ?? "null");
    return saved && typeof saved === "object" ? { ...EMPTY_BRAND, ...saved, intro: null, outro: false, bar: false } : EMPTY_BRAND;
  } catch {
    return EMPTY_BRAND;
  }
}
function saveBrand(b: BrandOptions) {
  try {
    localStorage.setItem(BRAND_KEY, JSON.stringify({ name: b.name, tagline: b.tagline, website: b.website, logo: b.logo }));
  } catch {
    // Private window / storage off: the kit just isn't remembered.
  }
}
const formatLength = (seconds: number) => {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

// The transitions a choice cycles through, or null for straight cuts.
function transitionCycle(style: StyleId, template: StyleTemplate | null): TransitionType[] | null {
  if (style === "none") return null;
  if (style === "mix") return MIX_CYCLE;
  if (style === "template") return template?.transitions ?? MIX_CYCLE;
  return [style];
}

// Decodes a picture for the stage, scaled down to STAGE_PICTURE_PX on its long side (readable
// back, so the look can apply). Falls back to the thumbnail where the full file won't decode here -
// and a null path loads just the thumbnail (a video's poster).
function loadStagePicture(path: string | null, thumbUrl: string | undefined): Promise<StagePicture | null> {
  const load = (src: string) =>
    new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  return (path ? load(convertFileSrc(path)) : Promise.resolve(null))
    .then((img) => img ?? (thumbUrl ? load(thumbUrl) : null))
    .then((img) => {
      if (!img || !img.naturalWidth) return null;
      const s = Math.min(1, STAGE_PICTURE_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * s));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * s));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    });
}

// Widths of words in a title look's face - what lets a template shrink a long line to fit.
let measureCtx: CanvasRenderingContext2D | null = null;
const measureText: MeasureText = (text, styleId, fontPx) => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const look = titleStyle(styleId)?.look;
  if (!measureCtx) return 0;
  measureCtx.font = titleFontCss(look?.fontFamily, fontPx);
  measureCtx.letterSpacing = `${(look?.letterSpacing ?? 0) * fontPx}px`;
  return measureCtx.measureText(text).width;
};

// ---------- small controls ----------

const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
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
      <span className="block text-[11.5px] text-neutral-500 dark:text-neutral-400 truncate">{hint}</span>
    </span>
    <span className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-neutral-300 dark:bg-neutral-700"}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  </button>
);

const TextField: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string; label: string; compact?: boolean }> = ({ value, onChange, placeholder, label, compact }) => (
  <input
    type="text"
    value={value}
    aria-label={label}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    className={`w-full ${compact ? "h-9 text-[13px]" : "h-10 text-[13.5px]"} px-3 rounded-xl bg-white dark:bg-neutral-950 ring-1 ring-neutral-200 dark:ring-white/10 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:ring-2 focus:ring-blue-500 outline-none`}
  />
);

// A style template's card: its colours, with its signature word drawn in its own title look.
// Memoized with stable callbacks, so hovering or picking one card re-renders only the cards whose
// state changed.
const TemplateCard = memo(function TemplateCard({
  template,
  active,
  onPick,
  onHover,
}: {
  template: StyleTemplate | null;
  active: boolean;
  onPick: (template: StyleTemplate | null) => void;
  onHover: (template: StyleTemplate | null, on: boolean) => void;
}) {
  const look = template ? titleStyle(template.cardStyle)?.look : null;
  return (
    <button
      type="button"
      onClick={() => onPick(template)}
      onMouseEnter={() => onHover(template, true)}
      onMouseLeave={() => onHover(template, false)}
      title={template?.blurb ?? "Set every part yourself"}
      className={`group shrink-0 w-[112px] text-left rounded-xl p-1 outline-none transition-all focus-visible:ring-2 focus-visible:ring-blue-400 ${
        active ? "bg-white shadow-sm ring-2 ring-blue-500 dark:bg-neutral-800" : "hover:bg-white/80 dark:hover:bg-white/[0.06]"
      }`}
    >
      <span
        className="relative block h-16 rounded-lg overflow-hidden"
        style={{ background: template ? `radial-gradient(120% 90% at 20% 10%, ${template.swatch[1]}, ${template.swatch[0]} 70%)` : undefined }}
      >
        {!template && <span className="absolute inset-0 bg-neutral-200 dark:bg-neutral-700" />}
        <span className="absolute inset-0 flex items-center justify-center transition-transform duration-300 group-hover:scale-110">
          {template && look ? (
            <TitleLookTile look={look} text={template.cardWord} width={104} height={64} />
          ) : (
            <span className="text-[12px] font-semibold text-neutral-600 dark:text-neutral-200">Your way</span>
          )}
        </span>
      </span>
      <span className="block px-0.5 pt-1 text-[12px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">{template?.label ?? "Custom"}</span>
    </button>
  );
});

// ---------- the media grid ----------

interface MediaItem {
  name: string;
  path: string;
  video: boolean;
}

// Tiles mount a page at a time as the grid scrolls - a library can hold thousands, and mounting
// them all at once is what made the dialog slow to open.
const GRID_PAGE = 120;

const MediaTile = memo(function MediaTile({
  item,
  order,
  thumbUrl,
  duration,
  onToggle,
}: {
  item: MediaItem;
  // Place in the sequence, -1 when not picked.
  order: number;
  thumbUrl: string | undefined;
  duration: number | undefined;
  onToggle: (path: string) => void;
}) {
  const on = order >= 0;
  return (
    <button
      data-thumb={item.path}
      type="button"
      onClick={() => onToggle(item.path)}
      title={item.name}
      className={`group relative aspect-square rounded-xl overflow-hidden bg-neutral-100 dark:bg-white/[0.04] flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-all ${
        on ? "ring-[3px] ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900" : ""
      }`}
    >
      <span className={`absolute inset-0 transition-transform duration-300 ${on ? "scale-[0.97]" : "group-hover:scale-105"}`}>
        <span className="absolute inset-0 flex items-center justify-center">
          {thumbUrl ? (
            <img src={thumbUrl} alt="" className="w-full h-full object-cover" draggable={false} decoding="async" />
          ) : (
            <IoImageOutline size={20} className="text-neutral-300 dark:text-neutral-600" />
          )}
        </span>
      </span>
      <span className={`absolute inset-0 transition-colors ${on ? "bg-blue-500/15" : "bg-black/0 group-hover:bg-black/10"}`} />
      {item.video && (
        <span className="absolute left-1.5 bottom-1.5 flex items-center gap-1 px-1.5 h-5 rounded-md bg-black/65 text-[10.5px] font-semibold text-white tabular-nums">
          <IoVideocam size={11} />
          {duration !== undefined ? formatLength(duration) : ""}
        </span>
      )}
      <span
        className={`absolute top-2 right-2 min-w-[22px] h-[22px] px-1 rounded-full text-[11px] font-semibold flex items-center justify-center tabular-nums transition-all ${
          on ? "bg-blue-500 text-white shadow" : "bg-black/25 text-transparent ring-1 ring-white/80 opacity-0 group-hover:opacity-100"
        }`}
      >
        {on ? order + 1 : <IoCheckmark size={12} />}
      </span>
    </button>
  );
});

// Memoized: the dialog re-renders on every style hover and click, and none of that touches the grid.
const MediaGrid = memo(function MediaGrid({
  media,
  picked,
  thumbUrls,
  videoInfo,
  scrollRef,
  onToggle,
  onNearView,
}: {
  media: MediaItem[];
  picked: string[];
  thumbUrls: Record<string, string>;
  videoInfo: Record<string, VideoInfo>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (path: string) => void;
  // Paths of tiles that came near view - their thumbnails are asked for then.
  onNearView: (paths: string[]) => void;
}) {
  const [limit, setLimit] = useState(GRID_PAGE);
  const [limitFor, setLimitFor] = useState(media);
  // Back to the first page when the filter changes (set during render, so no extra frame of the old count).
  if (limitFor !== media) {
    setLimitFor(media);
    setLimit(GRID_PAGE);
  }
  const shown = useMemo(() => (media.length > limit ? media.slice(0, limit) : media), [media, limit]);
  const orderOf = useMemo(() => new Map(picked.map((p, i) => [p, i])), [picked]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting && e.target !== sentinelRef.current).map((e) => (e.target as HTMLElement).dataset.thumb ?? "");
        if (seen.length) onNearView(seen);
        if (entries.some((e) => e.isIntersecting && e.target === sentinelRef.current)) setLimit((l) => l + GRID_PAGE * 2);
      },
      { root, rootMargin: "400px 0px" }
    );
    root.querySelectorAll<HTMLElement>("[data-thumb]").forEach((el) => io.observe(el));
    if (sentinelRef.current) io.observe(sentinelRef.current);
    return () => io.disconnect();
  }, [shown, scrollRef, onNearView]);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5 p-1.5 -mx-1.5">
        {shown.map((item) => (
          <MediaTile
            key={item.path}
            item={item}
            order={orderOf.get(item.path) ?? -1}
            thumbUrl={thumbUrls[item.path]}
            duration={videoInfo[item.path]?.duration}
            onToggle={onToggle}
          />
        ))}
      </div>
      {shown.length < media.length && <div ref={sentinelRef} className="h-px" />}
    </>
  );
});

// ---------- the dialog ----------

const NewVideoProjectDialog: React.FC<NewVideoProjectDialogProps> = ({ libraryImages, libraryVideos, resolveThumbnailUrl, resolveVideoThumbnailUrl, onCreate, onClose }) => {
  const [name, setName] = useState("Untitled video");
  // "auto": the shape most of the picked media are (autoFrameId).
  const [frameId, setFrameId] = useState("auto");
  // In clip order - the order images were picked in, rearranged by dragging in the sequence strip.
  const [picked, setPicked] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // The card under the pointer (null = Custom), tried out on the stage; undefined = none.
  const [hoverTemplateId, setHoverTemplateId] = useState<string | null | undefined>(undefined);
  // The words for each template, kept per template so trying another doesn't lose them.
  const [textsByTemplate, setTextsByTemplate] = useState<Record<string, Record<string, string>>>({});
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_CLIP_SECONDS);
  const [beatsPerPhoto, setBeatsPerPhoto] = useState(2);
  const [kenBurns, setKenBurns] = useState(true);
  const [style, setStyle] = useState<StyleId>("mix");
  const [hoverStyle, setHoverStyle] = useState<StyleId | null>(null);
  const [look, setLook] = useState<GradeLookName | null>(null);
  const [overlaysOn, setOverlaysOn] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [scenesOn, setScenesOn] = useState(true);
  // Photos of another shape: over a blurred copy of themselves, or with black bars.
  const [blurFill, setBlurFill] = useState(true);
  const [music, setMusic] = useState<MusicPick | null>(null);
  // Once the user has chosen a song (or no song) themselves, picking a style leaves it alone.
  const musicTouchedRef = useRef(false);
  const [catalog, setCatalog] = useState<MusicTrack[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Tempo found in a library song's preview clip, for songs the catalog has no beats for.
  const [previewBeats, setPreviewBeats] = useState<Record<string, TrackBeats>>({});
  const [musicMuted, setMusicMuted] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingStep, setCreatingStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbUrls, putThumbUrl] = useBatchedRecord<string>();
  const [stagePictures, setStagePictures] = useState<Map<string, StagePicture>>(new Map());
  const [aspects, setAspects] = useState<Record<string, number>>({});
  // Picked videos' length and shape (get_conversion_info) - a video takes part once it's known.
  const [videoInfo, setVideoInfo] = useState<Record<string, VideoInfo>>({});
  const [mediaFilter, setMediaFilter] = useState<"all" | "photos" | "videos">("all");
  const [mediaQuery, setMediaQuery] = useState("");
  // The grid re-filters behind the keystroke, so typing stays instant on a library of thousands.
  const deferredMediaQuery = useDeferredValue(mediaQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [brand, setBrandState] = useState<BrandOptions>(readBrand);
  const setBrand = (patch: Partial<BrandOptions>) =>
    setBrandState((prev) => {
      const next = { ...prev, ...patch };
      saveBrand(next);
      return next;
    });
  const [fontsReady, setFontsReady] = useState(false);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const dragRef = useRef<{ path: string; startX: number; moved: boolean } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const template = styleTemplate(templateId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isCreating) onClose();
      // Ctrl+F, or "/" when not typing, jumps to the media search.
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") || (event.key === "/" && !typing)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, isCreating]);

  // Every title face, so captions are measured and drawn in their own faces from the first frame.
  useEffect(() => {
    let cancelled = false;
    void loadTitleFonts(TITLE_FONTS.map((f) => f.id)).then(() => !cancelled && setFontsReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Library images plus anything picked from disk, de-duplicated - every tile either list shows.
  // Thumbnails are asked for as tiles come near view (a library can hold thousands), plus whatever
  // is picked and the logo.
  const [nearView, setNearView] = useState<Set<string>>(() => new Set());
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const thumbnailPaths = useMemo(() => Array.from(new Set([...picked, ...nearView, ...(brand.logo ? [brand.logo.path] : [])])), [picked, nearView, brand.logo]);
  useEffect(() => {
    let cancelled = false;
    thumbnailPaths
      .filter((path) => !thumbUrls[path])
      .forEach((path) => {
        thumbnailLimiter(() => (isVideoPath(path) ? resolveVideoThumbnailUrl : resolveThumbnailUrl)({ name: baseName(path), path }))
          .then((url) => !cancelled && putThumbUrl(path, url))
          .catch((err) => console.error("Failed to resolve thumbnail for", path, err));
      });
    return () => {
      cancelled = true;
    };
    // thumbUrls deliberately left out - same reasoning as VideoEditorHome's own thumbnail effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnailPaths, resolveThumbnailUrl, resolveVideoThumbnailUrl]);

  // A picked video's length and shape, asked for once.
  useEffect(() => {
    picked
      .filter((p) => isVideoPath(p) && !videoInfo[p])
      .forEach((p) => {
        invoke<Record<string, string>>("get_conversion_info", { inputPath: p })
          .then((info) => {
            const duration = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
            const res = info.resolution?.match(/^(\d+)x(\d+)$/);
            if (!Number.isFinite(duration) || duration <= 0) throw new Error("no duration");
            setVideoInfo((prev) => ({ ...prev, [p]: { duration, aspect: res ? Number(res[1]) / Number(res[2]) : 16 / 9 } }));
          })
          .catch((err) => {
            console.warn("Couldn't read video", p, err);
            setPicked((prev) => prev.filter((x) => x !== p));
            setError(`Couldn't read ${baseName(p)} - left it out.`);
          });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  const videoOf = useCallback((p: string) => videoInfo[p], [videoInfo]);
  const pickedVideos = useMemo(() => new Set(picked.filter(isVideoPath)), [picked]);

  // Each picked photo's shape (from its thumbnail) - collage cells crop to fill with it.
  useEffect(() => {
    let cancelled = false;
    picked
      .filter((p) => thumbUrls[p] && aspects[p] === undefined && !isVideoPath(p))
      .forEach((p) => {
        const img = new Image();
        img.onload = () => !cancelled && img.naturalHeight && setAspects((prev) => ({ ...prev, [p]: img.naturalWidth / img.naturalHeight }));
        img.src = thumbUrls[p];
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, thumbUrls]);

  const togglePicked = useCallback((path: string) => setPicked((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path])), []);
  const markNearView = useCallback((paths: string[]) => setNearView((prev) => (paths.every((p) => prev.has(p)) ? prev : new Set([...prev, ...paths]))), []);

  // Reordering the sequence follows the pointer (captured), not HTML drag and drop - the window's
  // native file-drop handling swallows HTML drag events in the WebView, so those never arrive.
  const onTilePointerDown = (e: React.PointerEvent<HTMLDivElement>, path: string) => {
    if (e.button !== 0) return;
    dragRef.current = { path, startX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onTilePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const strip = stripRef.current;
    if (!drag || !strip) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      setDraggingPath(drag.path);
    }
    // The new place: how many of the other tiles' centres are left of the pointer. Found by path,
    // against the latest order - pointer moves can outpace renders.
    let to = 0;
    strip.querySelectorAll<HTMLElement>("[data-sequence-tile]").forEach((el) => {
      if (el.dataset.sequenceTile === drag.path) return;
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) to++;
    });
    setPicked((prev) => {
      const from = prev.indexOf(drag.path);
      if (from < 0 || from === to) return prev;
      const next = prev.filter((p) => p !== drag.path);
      next.splice(to, 0, drag.path);
      return next;
    });
    // Near either end of the strip, scroll it along.
    const r = strip.getBoundingClientRect();
    if (e.clientX < r.left + 40) strip.scrollLeft -= 12;
    else if (e.clientX > r.right - 40) strip.scrollLeft += 12;
  };
  const onTilePointerUp = () => {
    dragRef.current = null;
    setDraggingPath(null);
  };

  const handleBrowse = async () => {
    const selected = await openFileDialog({
      multiple: true,
      filters: [
        { name: "Photos and videos", extensions: [...IMAGE_CLIP_EXTENSIONS, ...VIDEO_EXTENSIONS] },
        { name: "Photos", extensions: IMAGE_CLIP_EXTENSIONS },
        { name: "Videos", extensions: VIDEO_EXTENSIONS },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setPicked((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]);
  };

  // Auto picks the frame most of the media already fill: tall, square or wide.
  const autoFrameId = useMemo(() => {
    const shapes = picked.map((p) => (isVideoPath(p) ? videoInfo[p]?.aspect : aspects[p])).filter((a): a is number => !!a);
    if (!shapes.length) return "landscape";
    const tall = shapes.filter((a) => a < 0.85).length;
    const square = shapes.filter((a) => a >= 0.85 && a <= 1.15).length;
    const wide = shapes.length - tall - square;
    return tall > wide && tall >= square ? "portrait" : square > wide && square > tall ? "square" : "landscape";
  }, [picked, aspects, videoInfo]);
  const resolvedFrameId = frameId === "auto" ? autoFrameId : frameId;
  const frame = FRAME_PRESETS.find((preset) => preset.id === resolvedFrameId)?.frame ?? FRAME_PRESETS[0].frame;

  // ---- music ----

  useEffect(() => {
    let cancelled = false;
    fetchMusicCatalog(false)
      .then((r) => {
        if (cancelled) return;
        setCatalog(r.catalog.tracks);
        if (r.offline && !r.catalog.tracks.length) setCatalogError("The music library needs the internet the first time.");
      })
      .catch((err) => !cancelled && setCatalogError(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const musicBpm = music?.kind === "library" ? music.track.bpm ?? previewBeats[music.track.id]?.bpm : music?.bpm;
  const photoCount = Math.max(1, picked.length || Math.min(4, libraryImages.length));
  const perPhoto = music ? photoSecondsAt(musicBpm, beatsPerPhoto, imageDuration) : imageDuration;
  const suggestions = useMemo(
    () => (catalog ? suggestTemplateTracks(catalog, template?.music ?? MONTAGE_MUSIC, photoCount * photoSecondsAt(110, template?.beatsPerPhoto ?? 2, imageDuration), 6) : []),
    // Only re-ranked when the style or the catalog changes - not under the cursor as photos are picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, template]
  );

  // A style picks its first suggested song, until the user has chosen one themselves.
  useEffect(() => {
    if (musicTouchedRef.current) return;
    setMusic(template && suggestions[0] ? { kind: "library", track: suggestions[0] } : null);
  }, [template, suggestions]);

  const chooseMusic = (pick: MusicPick | null) => {
    musicTouchedRef.current = true;
    setMusic(pick);
    if (pick) setPlaying(true);
  };

  const handlePickMusicFile = async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Audio", extensions: FILE_CATEGORY_EXTENSIONS.audio }] });
    if (!selected || Array.isArray(selected)) return;
    try {
      const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: selected });
      const duration = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("couldn't read how long it is");
      chooseMusic({ kind: "file", path: selected, name: baseName(selected), duration });
      const beats = await invoke<TrackBeats>("detect_beats", { sourcePath: selected }).catch(() => null);
      if (beats) setMusic((m) => (m?.kind === "file" && m.path === selected ? { ...m, bpm: beats.bpm, beats: beats.beats } : m));
    } catch (err) {
      setError(`Couldn't use that song: ${err instanceof Error ? err.message : err}`);
    }
  };

  // The song as the stage's project uses it - a library song's preview clip is all the stage can
  // play, so its edit starts where the clip does (and Create keeps that start).
  const musicBeats = music?.kind === "library" ? (music.track.beats?.length ? music.track.beats : previewBeats[music.track.id]?.beats) : music?.beats;
  const stageMusic = useMemo<StyledProjectMusic | null>(() => {
    if (!music) return null;
    if (music.kind === "file") return { path: music.path, sourceDuration: music.duration, bpm: music.bpm, beats: music.beats, label: music.name };
    const preview = music.track.preview;
    return {
      path: "",
      sourceDuration: music.track.duration,
      bpm: musicBpm,
      beats: musicBeats,
      highlightStart: preview ? preview.start ?? 0 : music.track.highlightStart,
      label: music.track.title,
    };
  }, [music, musicBpm, musicBeats]);

  // ---- the project ----

  const texts = useMemo(() => (template ? textsByTemplate[template.id] ?? templateTexts(template) : {}), [template, textsByTemplate]);
  const setText = (id: string, value: string) => {
    if (!template) return;
    setTextsByTemplate((prev) => ({ ...prev, [template.id]: { ...(prev[template.id] ?? templateTexts(template)), [id]: value } }));
  };

  // The build options for a style: the dialog's own choices, or - while a card is only being tried
  // (`trying`) - that template's defaults, with any words already typed for it.
  const optionsFor = useCallback(
    (t: StyleTemplate | null, trying: boolean, transitionStyle: StyleId, song: StyledProjectMusic | null): StyledProjectOptions => ({
      templateId: t?.id ?? null,
      imageSeconds: trying ? t?.seconds ?? DEFAULT_IMAGE_CLIP_SECONDS : imageDuration,
      beatsPerPhoto: trying ? t?.beatsPerPhoto ?? 2 : beatsPerPhoto,
      motion: kenBurns || trying ? t?.motion ?? KEN_BURNS_CYCLE : null,
      motionIntensity: t?.motionIntensity ?? 0.5,
      transitions: transitionCycle(transitionStyle, t),
      transitionShare: t?.transitionShare ?? 1 / 3,
      look: trying ? t?.look ?? null : look,
      overlays: trying || overlaysOn,
      captions: trying || captionsOn,
      scenes: trying || scenesOn,
      texts: t ? textsByTemplate[t.id] ?? templateTexts(t) : {},
      music: song,
      brand: brand.intro || brand.outro || brand.bar ? brand : null,
    }),
    [imageDuration, beatsPerPhoto, kenBurns, look, overlaysOn, captionsOn, scenesOn, textsByTemplate, brand]
  );

  // What the stage plays: the picks (the first STAGE_MAX_PHOTOS), or a few library pictures as a
  // taste of the style - with a hovered card or transition tried out on top of the choices.
  const stagePaths = useMemo(() => (picked.length ? picked.slice(0, STAGE_MAX_PHOTOS) : libraryImages.slice(0, 8).map((i) => i.path)), [picked, libraryImages]);
  const shownTemplate = hoverTemplateId === undefined ? template : styleTemplate(hoverTemplateId);
  const trying = hoverTemplateId !== undefined && hoverTemplateId !== templateId;
  const shownStyle: StyleId = hoverStyle ?? (trying ? (shownTemplate ? "template" : "mix") : style);
  // Recomputed when a video's poster (its thumbnail) arrives, so the stage can show it.
  const videoPostersKey = stagePaths.filter(isVideoPath).map((p) => (thumbUrls[p] ? 1 : 0)).join("");
  // The stage rebuilds its project from these in a deferred render, so a style click or hover shows
  // as picked at once and the (heavier) new preview follows a beat later instead of holding it up.
  const stageInputs = useDeferredValue(
    useMemo(
      () => ({ template: shownTemplate, trying, style: shownStyle, optionsFor, frame, frameId: resolvedFrameId }),
      [shownTemplate, trying, shownStyle, optionsFor, frame, resolvedFrameId]
    )
  );
  const stageProject = useMemo(() => {
    const ready = stagePaths.filter((p) => stagePictures.has(p) && (!isVideoPath(p) || videoInfo[p]));
    if (!ready.length) return null;
    const { template: t, trying: tryingIt, style: transitionStyle, optionsFor: optionsOf, frame: stageFrame } = stageInputs;
    return buildStyledProject(ready, stageFrame, optionsOf(t, tryingIt, transitionStyle, stageMusic), {
      aspectOf: (p) => {
        const pic = stagePictures.get(p);
        return pic ? pic.width / pic.height : 1;
      },
      measure: fontsReady ? measureText : undefined,
      videoOf,
      fillVideos: blurFill,
    });
  }, [stagePaths, stagePictures, stageInputs, stageMusic, fontsReady, videoInfo, videoOf, blurFill]);

  // Decode the stage's pictures (full files, scaled down), a few at a time.
  useEffect(() => {
    let cancelled = false;
    stagePaths
      .filter((p) => !stagePictures.has(p))
      .forEach((p) => {
        // A video's poster is its thumbnail - the stage plays the video itself over it.
        if (isVideoPath(p) && !thumbUrls[p]) return;
        void stagePictureLimiter(() => loadStagePicture(isVideoPath(p) ? null : p, thumbUrls[p])).then((pic) => {
          if (!cancelled && pic) setStagePictures((prev) => (prev.has(p) ? prev : new Map(prev).set(p, pic)));
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagePaths, videoPostersKey]);

  // The brand logo, decoded for the stage like the photos.
  useEffect(() => {
    const logo = brand.logo?.path;
    if (!logo || stagePictures.has(logo)) return;
    let cancelled = false;
    void loadStagePicture(logo, thumbUrls[logo]).then((pic) => !cancelled && pic && setStagePictures((prev) => new Map(prev).set(logo, pic)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.logo?.path]);

  const handlePickLogo = async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Logo", extensions: ["png", "jpg", "jpeg", "webp", "svg", "gif"] }] });
    if (!selected || Array.isArray(selected)) return;
    const pic = await loadStagePicture(selected, undefined);
    if (!pic) return setError("Couldn't open that logo.");
    setStagePictures((prev) => new Map(prev).set(selected, pic));
    setBrand({ logo: { path: selected, aspect: pic.width / pic.height }, intro: brand.intro ?? "neon" });
  };

  // The song plays alongside the stage: a library song's preview clip, or the file - from where the
  // stage's project starts in it. songClock maps where it is to seconds into the edit.
  const audioRef = useRef<HTMLAudioElement>(null);
  const songMapRef = useRef<{ offset: number; anchor: number; ready: boolean }>({ offset: 0, anchor: 0, ready: false });
  const musicKey = music ? (music.kind === "library" ? music.track.id : music.path) : "";
  const stageTrimStart = stageProject?.audioOverlays[0]?.trimStart;
  useEffect(() => {
    const audio = audioRef.current;
    songMapRef.current = { offset: 0, anchor: 0, ready: false };
    if (!audio) return;
    audio.pause();
    if (!music) return;
    let cancelled = false;
    (async () => {
      try {
        let src: string;
        let offset = 0;
        if (music.kind === "library") {
          const path = await getTrackFile(music.track.id, music.track.preview ? "preview" : "full");
          src = convertFileSrc(path);
          offset = music.track.preview ? music.track.preview.start ?? 0 : 0;
          if (!music.track.beats?.length && !previewBeats[music.track.id]) {
            invoke<TrackBeats>("detect_beats", { sourcePath: path })
              .then((b) => !cancelled && setPreviewBeats((prev) => ({ ...prev, [music.track.id]: { bpm: b.bpm, beats: b.beats.map((x) => x + offset) } })))
              .catch(() => undefined);
          }
        } else src = convertFileSrc(music.path);
        if (cancelled) return;
        const anchor = stageTrimStart ?? musicStartFor({ sourceDuration: music.kind === "file" ? music.duration : music.track.duration, beats: musicBeats }, photoCount * perPhoto);
        if (audio.src !== src) audio.src = src;
        audio.loop = true;
        audio.currentTime = Math.max(0, anchor - offset);
        songMapRef.current = { offset, anchor, ready: true };
        if (playing) await audio.play();
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") console.warn("Song preview unavailable", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Restarts only for a different song, or when where the edit starts in it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicKey, musicBeats, stageTrimStart]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !music || !songMapRef.current.ready) return;
    if (playing) audio.play().catch(() => undefined);
    else audio.pause();
  }, [playing, music]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = musicMuted;
  }, [musicMuted]);
  const songClock = useCallback(() => {
    const audio = audioRef.current;
    const map = songMapRef.current;
    if (!audio || !map.ready || audio.readyState < 2) return null;
    return audio.currentTime + map.offset - map.anchor;
  }, []);

  // ---- styles ----

  const applyTemplate = (t: StyleTemplate | null) => {
    setTemplateId(t?.id ?? null);
    setHoverTemplateId(undefined);
    if (!t) {
      setStyle("mix");
      setLook(null);
      setImageDuration(DEFAULT_IMAGE_CLIP_SECONDS);
      setBeatsPerPhoto(2);
      return;
    }
    setStyle("template");
    // The brand cards the style is made for - when there's a brand to show.
    if (t.suggestBrand && (brand.name.trim() || brand.logo))
      setBrand({ intro: t.suggestBrand.intro ?? brand.intro, outro: t.suggestBrand.outro ?? brand.outro, bar: t.suggestBrand.bar ?? brand.bar });
    setLook(t.look);
    setImageDuration(t.seconds);
    setBeatsPerPhoto(t.beatsPerPhoto);
    setKenBurns(true);
    setOverlaysOn(true);
    setCaptionsOn(true);
    setScenesOn(true);
  };

  // Stable for the memoized cards; applyTemplate reads the latest brand through the ref.
  const applyTemplateRef = useRef(applyTemplate);
  applyTemplateRef.current = applyTemplate;
  const pickTemplate = useCallback((t: StyleTemplate | null) => applyTemplateRef.current(t), []);
  const hoverTemplate = useCallback((t: StyleTemplate | null, on: boolean) => setHoverTemplateId(on ? t?.id ?? null : undefined), []);

  // ---- create ----

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);
    try {
      let song: StyledProjectMusic | null = null;
      if (music && picked.length) {
        if (music.kind === "library") {
          setCreatingStep("Getting the song…");
          const path = await getTrackFile(music.track.id, "full");
          let beats: TrackBeats | null = music.track.bpm && music.track.beats?.length ? { bpm: music.track.bpm, beats: music.track.beats } : null;
          if (!beats) {
            setCreatingStep("Finding the beat…");
            beats = await invoke<TrackBeats>("detect_beats", { sourcePath: path }).catch(() => null);
          }
          // From where the stage played it, so the video is the one that was previewed.
          song = { path, sourceDuration: music.track.duration, ...(beats ?? {}), highlightStart: stageMusic?.highlightStart, label: music.track.title, library: libraryInfoOf(music.track) };
        } else {
          let beats: TrackBeats | null = music.bpm && music.beats ? { bpm: music.bpm, beats: music.beats } : null;
          if (!beats) {
            setCreatingStep("Finding the beat…");
            beats = await invoke<TrackBeats>("detect_beats", { sourcePath: music.path }).catch(() => null);
          }
          song = { path: music.path, sourceDuration: music.duration, ...(beats ?? {}), label: music.name.replace(/\.[^.]+$/, "") };
        }
      }
      // Photos of another shape get their filled stills made (once - they're cached), a few at a time.
      const fills = new Map<string, string>();
      if (blurFill && picked.length) {
        let done = 0;
        const queue = picked.filter((p) => !isVideoPath(p));
        const worker = async () => {
          for (let p = queue.shift(); p; p = queue.shift()) {
            setCreatingStep(`Fitting photos to the frame… ${++done}/${queue.length + done}`);
            fills.set(p, await photoFillPath(p, frame, aspects[p]).catch(() => p));
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      }
      setCreatingStep(picked.length ? "Putting it together…" : null);
      const state = picked.length
        ? buildStyledProject(picked, frame, optionsFor(template, false, style, song), {
            aspectOf: (p) => aspects[p] ?? 1,
            measure: fontsReady ? measureText : undefined,
            clipSource: (p) => fills.get(p) ?? p,
            videoOf,
            fillVideos: blurFill,
          })
        : undefined;
      trackEvent("video_project_created", { style: template?.id ?? "custom", music: song ? (song.library ? "library" : "file") : "none", photos: picked.length });
      await onCreate({
        name: name.trim() || "Untitled video",
        frame,
        imagePaths: picked,
        options: { imageDuration, kenBurns, transition: null },
        ...(state ? { state } : {}),
      });
    } catch (err) {
      setError(`Couldn't create the video: ${err instanceof Error ? err.message : err}`);
      setCreatingStep(null);
      setIsCreating(false);
    }
  };

  const renderThumb = (path: string) =>
    thumbUrls[path] ? (
      <img src={thumbUrls[path]} alt="" className="w-full h-full object-cover" draggable={false} />
    ) : (
      <IoImageOutline size={20} className="text-neutral-300 dark:text-neutral-600" />
    );

  const projectLength = stageProject && picked.length && picked.length <= STAGE_MAX_PHOTOS ? stageProject.clips.reduce((s, c) => s + c.end - c.start, 0) : picked.length * perPhoto;
  const mediaIndex = useMemo(
    () => buildMediaIndex<MediaItem>([...libraryImages.map((m) => ({ ...m, video: false })), ...libraryVideos.map((m) => ({ ...m, video: true }))]),
    [libraryImages, libraryVideos]
  );
  const mediaSearch = useMemo(() => searchMedia(mediaIndex, deferredMediaQuery), [mediaIndex, deferredMediaQuery]);
  const media = useMemo(
    () => (mediaFilter === "all" ? mediaSearch.items : mediaSearch.items.filter((m) => m.video === (mediaFilter === "videos"))),
    [mediaSearch, mediaFilter]
  );
  const searching = deferredMediaQuery.trim() !== "";
  const matchedVideos = useMemo(() => (searching ? mediaSearch.items.filter((m) => m.video).length : libraryVideos.length), [searching, mediaSearch, libraryVideos]);
  const matchedPhotos = searching ? mediaSearch.items.length - matchedVideos : libraryImages.length;
  // Best matches sort first - show them, not wherever the grid was scrolled to.
  useEffect(() => {
    gridScrollRef.current?.scrollTo({ top: 0 });
  }, [deferredMediaQuery]);
  const allPicked = media.length > 0 && media.every((i) => picked.includes(i.path));
  const musicTitle = music ? (music.kind === "library" ? music.track.title : music.name) : null;
  const musicArtist = music?.kind === "library" ? music.track.artist : music ? "From your computer" : null;
  const shownLook = trying ? shownTemplate?.look ?? null : look;
  const stageLabel = [
    shownTemplate ? shownTemplate.label : TRANSITION_STYLES.find((t) => t.id === shownStyle)?.label,
    shownLook ? GRADE_LOOKS.find((l) => l.value === shownLook)?.label : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // No backdrop-filter here or on the stage's buttons: with the stage animating under it, the
    // compositor re-blurs on every frame - measured at ~30ms a frame (60 -> 20 fps) in WebView2.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/60 p-4 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && !isCreating && onClose()}
    >
      <audio ref={audioRef} preload="auto" className="hidden" />
      <div
        role="dialog"
        aria-labelledby="new-video-project-title"
        className="w-full max-w-[1320px] h-full max-h-[900px] flex flex-col overflow-hidden rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
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
            <p className="text-[12px] text-neutral-500 dark:text-neutral-400">Pick photos and a style, add a song - it's cut to the beat, ready to edit.</p>
          </div>
          <button type="button" onClick={onClose} disabled={isCreating} aria-label="Close" className="p-2 -mr-2 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-row">
          {/* Media */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-6 pt-4 pb-3">
              <h3 className="text-[13px] font-semibold text-neutral-900 dark:text-white">Your media</h3>
              <div className="flex gap-0.5 p-0.5 rounded-full bg-neutral-100 dark:bg-white/[0.06]">
                {(
                  [
                    ["all", `All ${matchedPhotos + matchedVideos}`],
                    ["photos", `Photos ${matchedPhotos}`],
                    ["videos", `Videos ${matchedVideos}`],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMediaFilter(id)}
                    className={`h-7 px-2.5 rounded-full text-[11.5px] font-medium tabular-nums transition-colors ${
                      mediaFilter === id ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label
                className={`group/search flex items-center gap-1.5 h-8 pl-2.5 pr-1 flex-1 min-w-[140px] max-w-[300px] rounded-full ring-1 transition-colors cursor-text ${
                  mediaQuery
                    ? "bg-white ring-blue-400/70 dark:bg-white/[0.06] dark:ring-blue-400/50"
                    : "bg-neutral-100 ring-transparent hover:bg-neutral-200/70 focus-within:bg-white focus-within:ring-blue-400/70 dark:bg-white/[0.06] dark:hover:bg-white/[0.09] dark:focus-within:ring-blue-400/50"
                }`}
              >
                <IoSearch size={14} className={mediaQuery ? "text-blue-500 shrink-0" : "text-neutral-400 shrink-0"} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={mediaQuery}
                  onChange={(e) => setMediaQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && mediaQuery) {
                      // First Esc clears the search; the next one closes the dialog.
                      e.stopPropagation();
                      e.nativeEvent.stopImmediatePropagation();
                      setMediaQuery("");
                    } else if (e.key === "Enter" && media.length === 1) {
                      togglePicked(media[0].path);
                    }
                  }}
                  placeholder="Search names, folders, dates"
                  aria-label="Search your media"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-transparent text-[12.5px] text-neutral-900 dark:text-white placeholder:text-neutral-400 outline-none"
                />
                {mediaQuery ? (
                  <>
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-neutral-400">{media.length}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setMediaQuery("");
                        searchInputRef.current?.focus();
                      }}
                      aria-label="Clear search"
                      className="shrink-0 p-1 rounded-full text-neutral-400 hover:text-neutral-700 hover:bg-black/[0.06] dark:hover:text-white dark:hover:bg-white/10"
                    >
                      <IoClose size={13} />
                    </button>
                  </>
                ) : (
                  <kbd className="shrink-0 mr-1.5 px-1.5 rounded border border-neutral-200 dark:border-white/10 text-[10px] font-sans text-neutral-400 opacity-0 group-hover/search:opacity-100 transition-opacity">
                    Ctrl F
                  </kbd>
                )}
              </label>
              <span className="flex-1" />
              {media.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPicked(allPicked ? picked.filter((p) => !media.some((m) => m.path === p)) : [...picked, ...media.map((i) => i.path).filter((p) => !picked.includes(p))])}
                  className="h-8 px-3 rounded-full text-[12.5px] font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/[0.08]"
                >
                  {allPicked ? "Clear all" : searching ? `Select ${media.length}` : "Select all"}
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

            <div ref={gridScrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
              {searching && mediaSearch.fuzzy && media.length > 0 && (
                <p className="pb-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                  No exact match for &ldquo;{deferredMediaQuery.trim()}&rdquo; - showing close matches.
                </p>
              )}
              {searching && media.length === 0 ? (
                <div className="w-full h-full min-h-[220px] flex flex-col items-center justify-center gap-2 text-neutral-500 dark:text-neutral-400">
                  <IoSearch size={26} className="text-neutral-300 dark:text-neutral-600" />
                  <span className="text-[13px] font-medium">Nothing matches &ldquo;{deferredMediaQuery.trim()}&rdquo;</span>
                  <span className="text-[12px]">Try part of a file name, a folder, or a month like &ldquo;aug 2026&rdquo;</span>
                  <button
                    type="button"
                    onClick={() => setMediaQuery("")}
                    className="mt-1 h-8 px-3 rounded-full text-[12.5px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:text-blue-300 dark:bg-blue-500/10 dark:hover:bg-blue-500/20"
                  >
                    Clear search
                  </button>
                </div>
              ) : media.length > 0 ? (
                <MediaGrid
                  media={media}
                  picked={picked}
                  thumbUrls={thumbUrls}
                  videoInfo={videoInfo}
                  scrollRef={gridScrollRef}
                  onToggle={togglePicked}
                  onNearView={markNearView}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void handleBrowse()}
                  className="w-full h-full min-h-[220px] rounded-2xl border-2 border-dashed border-neutral-200 dark:border-white/10 flex flex-col items-center justify-center gap-2 text-neutral-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                >
                  <IoImageOutline size={30} />
                  <span className="text-[13px] font-medium">Choose photos and videos from your computer</span>
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
                    {picked.length} {picked.length === 1 ? "clip" : "clips"} · {formatLength(projectLength)} · drag to reorder
                  </span>
                )}
              </div>
              {picked.length > 0 ? (
                <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1 select-none">
                  {picked.map((path, i) => (
                    <div
                      key={path}
                      data-sequence-tile={path}
                      onPointerDown={(e) => onTilePointerDown(e, path)}
                      onPointerMove={onTilePointerMove}
                      onPointerUp={onTilePointerUp}
                      onPointerCancel={onTilePointerUp}
                      className={`group relative shrink-0 w-24 aspect-video rounded-lg overflow-hidden bg-neutral-100 dark:bg-white/[0.04] flex items-center justify-center touch-none transition-[opacity,transform,box-shadow] ${
                        draggingPath === path ? "cursor-grabbing scale-105 shadow-lg ring-2 ring-blue-500 z-10" : draggingPath ? "cursor-grabbing opacity-80" : "cursor-grab"
                      }`}
                    >
                      {renderThumb(path)}
                      <span className="absolute bottom-1 left-1 flex items-center gap-0.5 px-1.5 rounded-md bg-black/60 text-[10px] font-semibold text-white tabular-nums">
                        {isVideoPath(path) && <IoVideocam size={10} />}
                        {i + 1}
                      </span>
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
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
          <aside className="w-[420px] shrink-0 min-h-0 overflow-hidden flex flex-col border-l border-neutral-100 dark:border-white/[0.06] bg-neutral-50/70 dark:bg-white/[0.02]">
            <div className="relative shrink min-h-[170px] h-[300px] m-4 mb-0 rounded-2xl bg-neutral-950 overflow-hidden ring-1 ring-black/5 dark:ring-white/[0.07]">
              <div className="absolute inset-3 bottom-12">
                {stageProject ? (
                  <ProjectStage
                    project={stageProject}
                    frame={stageInputs.frame}
                    images={stagePictures}
                    blurFill={blurFill}
                    videoPaths={pickedVideos}
                    playing={playing}
                    restartKey={`${stageInputs.style}|${stageInputs.frameId}|${stageInputs.template?.id ?? ""}`}
                    songClock={music ? songClock : null}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/40">{stagePaths.length ? "Loading photos…" : "Your preview plays here"}</div>
                )}
              </div>
              <div className="absolute left-3 right-3 bottom-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPlaying((p) => !p)}
                  aria-label={playing ? "Pause preview" : "Play preview"}
                  className="w-8 h-8 rounded-full bg-neutral-800/80 hover:bg-neutral-700/90 text-white flex items-center justify-center"
                >
                  {playing ? <IoPause size={14} /> : <IoPlay size={14} className="translate-x-[1px]" />}
                </button>
                {music && (
                  <button
                    type="button"
                    onClick={() => setMusicMuted((m) => !m)}
                    aria-label={musicMuted ? "Unmute song" : "Mute song"}
                    className="w-8 h-8 rounded-full bg-neutral-800/80 hover:bg-neutral-700/90 text-white flex items-center justify-center"
                  >
                    {musicMuted ? <IoVolumeMuteOutline size={15} /> : <IoVolumeHighOutline size={15} />}
                  </button>
                )}
                {!picked.length && stagePaths.length > 0 && <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10.5px] text-white/70">Sample</span>}
                {picked.length > STAGE_MAX_PHOTOS && <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10.5px] text-white/70">First {STAGE_MAX_PHOTOS}</span>}
                <span className="flex-1" />
                <span className="text-[11px] text-white/55 truncate">{stageLabel}</span>
              </div>
            </div>

            {/* Style templates */}
            <div className="shrink-0 px-4 pt-3">
              <div className="flex items-center justify-between px-1 mb-0.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">Style</h3>
                <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400 truncate ml-2">{(shownTemplate ?? template)?.blurb ?? "Your own pace, transitions and look"}</span>
              </div>
              {/* pt-1: a scroller clips vertically too, and the active card's ring sits outside its box. */}
              <div className="flex gap-1.5 overflow-x-auto pt-1 pb-2 -mx-1 px-1" onMouseLeave={() => setHoverTemplateId(undefined)}>
                {[null, ...STYLE_TEMPLATES].map((t) => (
                  <TemplateCard key={t?.id ?? "custom"} template={t} active={(t?.id ?? null) === templateId} onPick={pickTemplate} onHover={hoverTemplate} />
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-[150px] overflow-y-auto px-5 py-4 flex flex-col gap-5 border-t border-neutral-100 dark:border-white/[0.06]">
              {template && (
                <Section title="Words" aside={<span className="text-[11px] text-neutral-400">Clear a line to leave it out</span>}>
                  <div className="flex flex-col gap-2">
                    {template.texts.map((t) => (
                      <label key={t.id} className="flex flex-col gap-1">
                        <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{t.label}</span>
                        <TextField compact value={texts[t.id] ?? ""} onChange={(v) => setText(t.id, v)} placeholder="Left out" label={t.label} />
                      </label>
                    ))}
                  </div>
                </Section>
              )}

              <Section
                title="Music"
                aside={
                  <button type="button" onClick={() => void handlePickMusicFile()} className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-300">
                    <IoFolderOpenOutline size={13} />
                    From computer
                  </button>
                }
              >
                {music && (
                  <div className="flex items-center gap-2.5 p-2 rounded-xl bg-white dark:bg-neutral-950 ring-1 ring-blue-500/40">
                    <span className="w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 text-white flex items-center justify-center">
                      <IoMusicalNotes size={16} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-medium text-neutral-900 dark:text-white truncate">{musicTitle}</span>
                      <span className="block text-[11.5px] text-neutral-500 dark:text-neutral-400 truncate">
                        {musicArtist}
                        {musicBpm ? ` · ${Math.round(musicBpm)} BPM` : ""}
                      </span>
                    </span>
                    {music.kind === "library" && suggestions.length > 1 && (
                      <button
                        type="button"
                        title="Another suggestion"
                        onClick={() => {
                          const i = suggestions.findIndex((t) => t.id === music.track.id);
                          chooseMusic({ kind: "library", track: suggestions[(i + 1) % suggestions.length] });
                        }}
                        className="p-1.5 rounded-full text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/10"
                      >
                        <IoShuffle size={15} />
                      </button>
                    )}
                    <button type="button" title="No music" aria-label="No music" onClick={() => chooseMusic(null)} className="p-1.5 rounded-full text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/10">
                      <IoClose size={15} />
                    </button>
                  </div>
                )}
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions
                      .filter((t) => music?.kind !== "library" || t.id !== music.track.id)
                      .slice(0, 4)
                      .map((t) => (
                        <Pill key={t.id} active={false} onClick={() => chooseMusic({ kind: "library", track: t })} title={`${t.title} - ${t.artist}`}>
                          <span className="flex items-center gap-1 max-w-[140px]">
                            <IoMusicalNotes size={11} className="shrink-0" />
                            <span className="truncate">{t.title}</span>
                          </span>
                        </Pill>
                      ))}
                  </div>
                ) : (
                  !music && <p className="text-[12px] text-neutral-500 dark:text-neutral-400">{catalogError ?? (catalog ? "No songs in the library yet." : "Loading songs…")}</p>
                )}
                {music && <p className="text-[11.5px] text-neutral-500 dark:text-neutral-400">Every cut lands on the beat. Change or trim the song later in the editor.</p>}
              </Section>

              <Section
                title="Brand"
                aside={
                  <span className="text-[11px] text-neutral-400">{brand.name || brand.logo ? "Remembered for next time" : "Logo intro & closing card"}</span>
                }
              >
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void handlePickLogo()}
                    title={brand.logo ? "Change logo" : "Add your logo"}
                    className="relative w-16 h-16 shrink-0 rounded-xl ring-1 ring-neutral-200 dark:ring-white/10 bg-[conic-gradient(#e5e7eb_25%,#fff_0_50%,#e5e7eb_0_75%,#fff_0)] bg-[length:12px_12px] dark:bg-[conic-gradient(#262626_25%,#171717_0_50%,#262626_0_75%,#171717_0)] overflow-hidden flex items-center justify-center hover:ring-blue-400 transition"
                  >
                    {brand.logo && thumbUrls[brand.logo.path] ? (
                      <img src={thumbUrls[brand.logo.path]} alt="" className="max-w-[85%] max-h-[85%] object-contain" />
                    ) : brand.logo ? (
                      <IoImageOutline size={18} className="text-neutral-400" />
                    ) : (
                      <span className="text-[10.5px] font-medium text-neutral-500 leading-tight text-center px-1">Add logo</span>
                    )}
                  </button>
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <TextField compact value={brand.name} onChange={(name) => setBrand({ name })} placeholder="Brand name" label="Brand name" />
                    <TextField compact value={brand.tagline} onChange={(tagline) => setBrand({ tagline })} placeholder="Tagline (optional)" label="Tagline" />
                  </div>
                </div>
                <TextField compact value={brand.website} onChange={(website) => setBrand({ website })} placeholder="Website or @handle (optional)" label="Website" />
                {brand.logo && (
                  <button type="button" onClick={() => setBrand({ logo: null })} className="self-start text-[11.5px] text-neutral-500 hover:text-red-500">
                    Remove logo
                  </button>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">Opening</span>
                  <div className="flex flex-wrap gap-1.5">
                    <Pill active={!brand.intro} onClick={() => setBrand({ intro: null })}>
                      None
                    </Pill>
                    {BRAND_INTROS.map((b) => (
                      <Pill key={b.id} active={brand.intro === b.id} onClick={() => setBrand({ intro: b.id as BrandIntroStyle })} title={b.blurb}>
                        {b.label}
                      </Pill>
                    ))}
                  </div>
                </div>
                <Switch on={brand.outro} onChange={(outro) => setBrand({ outro })} label="Closing card" hint="Logo, name and website at the end" />
                <Switch on={brand.bar} onChange={(bar) => setBrand({ bar })} label="Brand bar" hint="Name along the top, website along the bottom" />
                {(brand.intro || brand.outro || brand.bar) && !brand.name.trim() && !brand.logo && (
                  <p className="text-[11.5px] text-amber-600 dark:text-amber-400">Add a logo or a brand name to show it.</p>
                )}
              </Section>

              <Section title="Name">
                <TextField value={name} onChange={setName} label="Video name" />
              </Section>

              <Section title="Format">
                <div className="grid grid-cols-5 gap-1 p-1 rounded-xl bg-neutral-100 dark:bg-white/[0.05]">
                  <button
                    type="button"
                    onClick={() => setFrameId("auto")}
                    title="Fits most of your media - tall, square or wide"
                    className={`flex flex-col items-center gap-1 py-1.5 rounded-lg text-[11px] font-medium transition-all outline-none ${
                      frameId === "auto" ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-sm" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                    }`}
                  >
                    <span className="h-5 flex items-center">
                      <IoSparkles size={14} className={frameId === "auto" ? "text-blue-500" : ""} />
                    </span>
                    {frameId === "auto" ? FRAME_PRESETS.find((p) => p.id === autoFrameId)?.hint : "Auto"}
                  </button>
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
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-neutral-500 dark:text-neutral-400 flex-1">Photos of another shape</span>
                  <Pill active={blurFill} onClick={() => setBlurFill(true)} title="Fill the frame with a soft, blurred copy of the photo">
                    Blur fill
                  </Pill>
                  <Pill active={!blurFill} onClick={() => setBlurFill(false)} title="Black bars around the photo">
                    Bars
                  </Pill>
                </div>
              </Section>

              {music ? (
                <Section title="Cut every" aside={<span className="text-[12px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200">{perPhoto.toFixed(1)}s a photo</span>}>
                  <div className="flex gap-1.5">
                    {BEAT_CHOICES.map((b) => (
                      <Pill key={b} active={beatsPerPhoto === b} onClick={() => setBeatsPerPhoto(b)}>
                        {b === 1 ? "Beat" : `${b} beats`}
                      </Pill>
                    ))}
                  </div>
                </Section>
              ) : (
                <Section title="Each photo" aside={<span className="text-[12px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200">{imageDuration}s</span>}>
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.1}
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
              )}

              <div className="flex flex-col gap-3.5">
                <Switch on={kenBurns} onChange={setKenBurns} label="Camera motion" hint={template ? `${template.label} moves - zooms, pans and drifts` : "Gentle zoom & pan on every photo"} />
                {template && <Switch on={captionsOn} onChange={setCaptionsOn} label="Captions" hint="The style's animated titles and words" />}
                {template && template.scenes.length > 0 && (
                  <Switch on={scenesOn} onChange={setScenesOn} label="Collages" hint={template.scenes.map((s) => (s.kind === "grid" ? "Photo grid" : s.kind === "triptych" ? "Framed trio" : "Word panels")).join(" + ")} />
                )}
                {template && (template.overlays.length > 0 || template.fx.some(Boolean)) && (
                  <Switch
                    on={overlaysOn}
                    onChange={setOverlaysOn}
                    label="Effects"
                    hint={[...template.overlays.map((k) => assetEntry(k).label), ...Array.from(new Set(template.fx.filter(Boolean))).map((k) => CLIP_FX.find((f) => f.value === k)?.label)].filter(Boolean).join(" + ")}
                  />
                )}
              </div>

              <Section title="Transitions">
                <div className="flex flex-wrap gap-1.5" onMouseLeave={() => setHoverStyle(null)}>
                  {template && (
                    <Pill active={style === "template"} onClick={() => setStyle("template")} onHover={(on) => setHoverStyle(on ? "template" : null)} title={`${template.label}'s own mix`}>
                      <span className="flex items-center gap-1">
                        <IoSparkles size={12} /> {template.label}
                      </span>
                    </Pill>
                  )}
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
            ) : creatingStep ? (
              creatingStep
            ) : picked.length > 0 ? (
              `About ${formatLength(projectLength)} long${template ? ` in ${template.label} style` : ""}${music ? `, cut to "${musicTitle}"` : ""} - every part stays editable.`
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
            className="flex items-center gap-1.5 h-10 px-5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-[13.5px] font-semibold shadow-md shadow-blue-600/25 disabled:opacity-60 transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
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
