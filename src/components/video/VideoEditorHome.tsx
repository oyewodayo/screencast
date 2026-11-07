// components/video/VideoEditorHome.tsx
//
// The Video Editor's landing screen - shown whenever the docker's Video Editor icon is clicked,
// the same way WhiteboardHome/MindmapHome back their own tool icons. Its job is to get from a
// standing start to editing in one move:
//
//   - Continue editing: the last video edited, as it now stands - how long it runs, what's in it,
//     its canvas (a vertical edit shown on a phone) - with Resume, and Send to phone for its latest
//     export (edit -> phone -> post, the loop people come back for).
//   - Start something new: open any video, make one from photos, or a starter that opens the editor
//     already set up for it - a vertical 9:16 canvas, a split screen, Shorts (editorIntent.ts).
//     A starter asks which video first: the library below becomes the picker.
//   - The library: every video, with what matters at a glance - length, shape (a vertical video
//     shown whole, not cropped), whether it's been edited or is an export - filters, sorting, and a
//     moving preview on hover.
//   - Dropping a video file anywhere on the screen opens it for editing (Dashboard's drop handler).
//
// Unlike Whiteboard/Mindmap there's no VideoEditorWorkspace home|editor switch here, because the
// editor itself isn't a separate component to switch to - opening a video just puts Dashboard in
// the state it's always had for an open video (VideoPlayer in the main pane + FileToolsDocker's
// video timeline/tools below), with dockerMode forced to "file-tools" so the tools are already
// open rather than needing the "show tools for this file" click. See Dashboard.tsx's
// VideoEditorScreen for the two states that model that.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  IoArrowForward,
  IoClose,
  IoCloudUploadOutline,
  IoCutOutline,
  IoFilmOutline,
  IoFolderOpenOutline,
  IoImagesOutline,
  IoPhonePortraitOutline,
  IoPlay,
  IoSearchOutline,
  IoSparkles,
  IoTimeOutline,
} from "react-icons/io5";
import { MdViewQuilt } from "react-icons/md";
import { formatFileSize, formatMediaDuration } from "../../utils/Formater";
import { thumbnailLimiter } from "../../utils/concurrencyLimiter";
import { isVideoProjectPath } from "../../utils/videoEditTypes";
import { getFileCategory } from "../../utils/fileCategory";
import { useBatchedRecord } from "../../hooks/useBatchedRecord";
import { relativeTime } from "../../utils/homeLibraryItems";
import { EditSummary, VideoProbe, describeEdit, exportBase, exportLabel, exportsOf, isExportName, probeVideo, readEditSummary } from "../../utils/videoLibraryMeta";
import type { EditorIntent } from "../../utils/editorIntent";

export interface VideoEditorFile {
  name: string;
  path: string;
  size: number;
  // ms since epoch, when the library knows it.
  modified?: number;
}

interface VideoEditorHomeProps {
  // Every video in the library, flattened across folders - this screen is explicitly "edit any
  // video", so it deliberately ignores whichever folder/category the sidebar happens to be on.
  videos: VideoEditorFile[];
  // Recently-opened file paths (utils/homeScreenFiles.ts), newest first. Filtered against
  // `videos` below, so a recent entry for a deleted/moved file or a non-video simply drops out.
  recentPaths: string[];
  // Poster-frame preview for a tile - Dashboard.tsx's resolveVideoThumbnailUrl, the same cached
  // ffmpeg frame extraction VideoFolderGallery's tiles use.
  resolveThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  // Opens a video in the editor - set up for `intent` when it came from a starter.
  onOpenVideo: (file: VideoEditorFile, intent?: EditorIntent) => void;
  // Opens the OS file picker filtered to video extensions and edits whatever comes back, from
  // anywhere on disk - the reason this screen exists as a standalone tool rather than only being
  // reachable from a file that's already open in the library.
  onOpenExternalVideo: (intent?: EditorIntent) => void;
  // Opens NewVideoProjectDialog - a new video built from images, or a blank timeline. Projects
  // (.briefvideo) then show up in `videos` like any other editable file.
  onCreateVideo: () => void;
  // Sends files to a paired phone (phoneTransfer.ts).
  onSendToPhone: (files: { path: string; name: string }[]) => void;
  // A file is being dragged over the window from outside - the screen shows where to drop it.
  externalDrag?: boolean;
  // Files just dropped on the window: the first video among them opens for editing.
  droppedPaths?: { paths: string[]; at: number } | null;
  // Opens "Tidy up library" (TidyLibraryDialog) - offered while projects or exports sit outside
  // their folders.
  onTidyUp?: () => void;
}

// Below this many videos the search box is more clutter than help - same threshold reasoning as
// WhiteboardHome's own search box.
const SEARCH_VISIBLE_THRESHOLD = 6;
// How long the pointer rests on a tile before it starts moving.
const HOVER_PREVIEW_DELAY_MS = 350;

type Filter = "all" | "edited" | "vertical" | "exports" | "projects";
type Sort = "recent" | "name" | "length" | "size";

interface Starter {
  id: string;
  title: string;
  hint: string;
  isNew?: boolean;
  // Asks for a video, then opens it set up like this.
  intent?: EditorIntent;
}

const STARTERS: Starter[] = [
  { id: "vertical", title: "Vertical video", hint: "9:16 for TikTok, Reels & Shorts", isNew: true, intent: { canvas: "vertical" } },
  { id: "split", title: "Split screen", hint: "You and your media, stacked", isNew: true, intent: { canvas: "vertical", split: true } },
  { id: "shorts", title: "Make Shorts", hint: "The best moments of a long video", intent: { shorts: true } },
];

const isVertical = (p: VideoProbe | undefined) => !!p?.width && !!p?.height && p.height > p.width;

// ---- Tiles ----------------------------------------------------------------------------------

// A poster that keeps a vertical video whole: the frame fitted in over a blurred copy of itself.
const Poster: React.FC<{ url: string | undefined; vertical: boolean; className?: string }> = ({ url, vertical, className = "" }) =>
  url ? (
    vertical ? (
      <span className={`absolute inset-0 ${className}`}>
        <img src={url} alt="" draggable={false} decoding="async" className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-75" />
        <img src={url} alt="" draggable={false} decoding="async" className="absolute inset-0 w-full h-full object-contain" />
      </span>
    ) : (
      <img src={url} alt="" draggable={false} decoding="async" className={`absolute inset-0 w-full h-full object-cover ${className}`} />
    )
  ) : null;

interface TileProps {
  video: VideoEditorFile;
  thumbUrl: string | undefined;
  probe: VideoProbe | undefined;
  edit: EditSummary | null | undefined;
  previewing: boolean;
  picking: boolean;
  // Its exports, newest first - shown on it rather than as tiles of their own.
  exports: VideoEditorFile[] | undefined;
  onOpen: (video: VideoEditorFile) => void;
  onVisible: (path: string) => void;
  onHover: (path: string | null) => void;
  onSendToPhone: (video: VideoEditorFile) => void;
}

// Memoized so a thumbnail or a probe arriving re-renders its own tile, not the whole grid.
const VideoTile = memo(function VideoTile({ video, thumbUrl, probe, edit, previewing, picking, exports, onOpen, onVisible, onHover, onSendToPhone }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Asks for its poster, length and edit only once it scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (onVisible(video.path), io.disconnect()), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [video.path, onVisible]);
  const project = isVideoProjectPath(video.path);
  const exported = isExportName(video.path);
  const duration = edit?.outputDuration || probe?.duration || null;
  const when = edit?.updatedAt ?? video.modified;
  const meta = [duration ? formatMediaDuration(duration) : null, project ? "Project" : formatFileSize(video.size), when ? (edit?.updatedAt ? `edited ${relativeTime(when)}` : relativeTime(when)) : null].filter(Boolean).join(" · ");
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(video)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(video))}
      onPointerEnter={() => onHover(video.path)}
      onPointerLeave={() => onHover(null)}
      title={picking ? `Use ${video.name}` : `Edit ${video.name}`}
      className={`group text-left rounded-xl overflow-hidden bg-white dark:bg-neutral-900 border shadow-sm hover:shadow-md transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500 ${
        picking ? "border-blue-300 dark:border-blue-500/50 hover:border-blue-500 hover:-translate-y-0.5" : "border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500"
      }`}
    >
      <div className="relative aspect-video bg-neutral-100 dark:bg-neutral-950 overflow-hidden">
        {thumbUrl ? <Poster url={thumbUrl} vertical={isVertical(probe)} /> : <span className="absolute inset-0 flex items-center justify-center"><IoFilmOutline size={28} className="text-neutral-300 dark:text-neutral-700" /></span>}
        {previewing && <HoverPreview path={video.path} start={probe?.duration ? probe.duration * 0.15 : 0} vertical={isVertical(probe)} />}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none">
          {!previewing && <IoPlay size={26} className="text-white opacity-0 group-hover:opacity-90 transition-opacity drop-shadow" />}
        </div>
        <div className="absolute left-2 top-2 flex gap-1 pointer-events-none">
          {edit && <span className="px-1.5 py-0.5 rounded bg-blue-600/90 text-white text-[10px] font-medium">Edited</span>}
          {exported && <span className="px-1.5 py-0.5 rounded bg-emerald-600/90 text-white text-[10px] font-medium">Export</span>}
          {edit?.canvasLabel && edit.canvasAspect && <span className="px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium">{edit.canvasAspect < 1 ? "Vertical" : edit.canvasLabel}</span>}
        </div>
        {duration && <span className="absolute right-2 bottom-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium tabular-nums pointer-events-none">{formatMediaDuration(duration)}</span>}
        {!picking && (!project || !!exports?.length) && (
          <button
            type="button"
            // What gets shared is the finished video, when there is one.
            title={exports?.length ? `Send the latest export (${exportLabel(exports[0].path)}) to your phone` : "Send to your phone"}
            onClick={(e) => {
              e.stopPropagation();
              onSendToPhone(exports?.[0] ?? video);
            }}
            className="absolute right-2 top-2 p-1.5 rounded-full bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/75 transition-opacity"
          >
            <IoPhonePortraitOutline size={14} />
          </button>
        )}
      </div>
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium leading-snug text-gray-800 dark:text-neutral-100 line-clamp-2 break-words">{video.name}</p>
        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500 truncate">{meta}</p>
        {!!exports?.length && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mr-0.5">Exports</span>
            {exports.slice(0, 3).map((e) => (
              <button
                key={e.path}
                type="button"
                title={`Open ${e.name}${e.modified ? ` - exported ${relativeTime(e.modified)}` : ""}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpen(e);
                }}
                className="px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10.5px] font-medium hover:bg-emerald-500/20"
              >
                {exportLabel(e.path)}
                {e.modified ? <span className="ml-1 font-normal opacity-70">{relativeTime(e.modified)}</span> : null}
              </button>
            ))}
            {exports.length > 3 && <span className="text-[10.5px] text-neutral-400">+{exports.length - 3}</span>}
          </div>
        )}
      </div>
    </div>
  );
});

// The tile's video moving under the pointer - one at a time (the webview has few decoders to
// spare), muted, from a little way in.
const HoverPreview: React.FC<{ path: string; start: number; vertical: boolean }> = ({ path, start, vertical }) => {
  const [shown, setShown] = useState(false);
  return (
    <video
      src={convertFileSrc(path)}
      muted
      autoPlay
      loop
      playsInline
      onLoadedMetadata={(e) => {
        if (start > 0) e.currentTarget.currentTime = start;
      }}
      onPlaying={() => setShown(true)}
      className={`absolute inset-0 w-full h-full ${vertical ? "object-contain bg-black/40" : "object-cover"} transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
    />
  );
};

// ---- Starters -------------------------------------------------------------------------------

// Each starter's little picture of what it makes.
const StarterArt: React.FC<{ id: string }> = ({ id }) => {
  const phone = "relative w-[30px] h-[52px] rounded-[7px] ring-2 ring-current overflow-hidden";
  if (id === "open") return <IoFolderOpenOutline size={30} />;
  if (id === "photos") return <IoImagesOutline size={30} />;
  if (id === "vertical")
    return (
      <span className={phone}>
        <span className="absolute inset-x-0 top-[30%] h-[40%] bg-current opacity-80" />
        <span className="absolute inset-0 bg-current opacity-20" />
      </span>
    );
  if (id === "split")
    return (
      <span className={phone}>
        <span className="absolute inset-x-[3px] top-[3px] h-[40%] rounded-[2px] bg-current opacity-80" />
        <span className="absolute inset-x-[3px] bottom-[3px] h-[50%] rounded-[2px] bg-current opacity-40" />
      </span>
    );
  return <IoSparkles size={28} />;
};

const StarterCard: React.FC<{ id: string; title: string; hint: string; isNew?: boolean; active?: boolean; onClick: () => void }> = ({ id, title, hint, isNew, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`relative flex items-center gap-3 p-3 rounded-xl border text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-[0.98] ${
      active ? "bg-blue-50 dark:bg-blue-500/10 border-blue-400" : "bg-white dark:bg-neutral-900 border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm"
    }`}
  >
    <span className={`shrink-0 w-12 h-14 flex items-center justify-center ${id === "open" ? "text-blue-600 dark:text-blue-400" : "text-neutral-500 dark:text-neutral-400"}`}>
      <StarterArt id={id} />
    </span>
    <span className="min-w-0">
      <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-neutral-100">
        {title}
        {isNew && <span className="px-1.5 py-px rounded-full bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300 text-[10px] font-semibold">New</span>}
      </span>
      <span className="block text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{hint}</span>
    </span>
  </button>
);

// ---- Continue editing -------------------------------------------------------------------------

const ContinueCard: React.FC<{
  video: VideoEditorFile;
  thumbUrl: string | undefined;
  probe: VideoProbe | undefined;
  edit: EditSummary;
  latestExport: VideoEditorFile | undefined;
  onResume: () => void;
  onSendToPhone: (file: VideoEditorFile) => void;
}> = ({ video, thumbUrl, probe, edit, latestExport, onResume, onSendToPhone }) => {
  const vertical = (edit.canvasAspect ?? 1) < 1;
  const parts = describeEdit(edit);
  const trimmed = edit.sourceDuration > 0 && edit.outputDuration > 0 && Math.abs(edit.sourceDuration - edit.outputDuration) > 0.5;
  return (
    <section className="mt-8 rounded-2xl overflow-hidden bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 shadow-sm flex flex-col sm:flex-row">
      {/* The edit as it'll be seen: a vertical canvas on a phone, over its own blurred poster. */}
      <button type="button" onClick={onResume} title="Resume editing" className="group relative sm:w-[46%] shrink-0 aspect-video bg-neutral-900 overflow-hidden outline-none">
        {thumbUrl && <img src={thumbUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl brightness-50" />}
        {vertical ? (
          <span className="absolute inset-y-[8%] left-1/2 -translate-x-1/2 aspect-[9/19.5] rounded-[18px] ring-[3px] ring-black/80 shadow-2xl overflow-hidden bg-black">
            <Poster url={thumbUrl} vertical />
            <span className="absolute left-1/2 -translate-x-1/2 top-[3%] w-[30%] h-[3.5%] rounded-full bg-black" />
          </span>
        ) : (
          <span className="absolute inset-[7%] rounded-lg overflow-hidden shadow-2xl">
            <Poster url={thumbUrl} vertical={isVertical(probe)} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="p-3 rounded-full bg-white/90 text-blue-600 shadow-lg scale-90 opacity-0 group-hover:opacity-100 group-hover:scale-100 transition-all">
            <IoPlay size={22} />
          </span>
        </span>
      </button>
      <div className="flex-1 min-w-0 p-5 flex flex-col">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
          <IoTimeOutline size={13} />
          Continue editing
        </span>
        <h2 className="mt-1.5 text-lg font-semibold text-gray-900 dark:text-neutral-50 leading-snug line-clamp-2 break-words">{video.name}</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {[edit.updatedAt ? `Edited ${relativeTime(edit.updatedAt)}` : null, edit.outputDuration ? `${formatMediaDuration(edit.outputDuration)}${trimmed ? ` (from ${formatMediaDuration(edit.sourceDuration)})` : ""}` : null].filter(Boolean).join(" · ")}
        </p>
        {(parts.length > 0 || edit.canvasLabel) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {edit.canvasLabel && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-300 text-xs">
                <IoPhonePortraitOutline size={12} />
                {edit.canvasLabel}
              </span>
            )}
            {parts.map((p) => (
              <span key={p} className="px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs">
                {p}
              </span>
            ))}
          </div>
        )}
        <div className="mt-auto pt-5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onResume} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 active:scale-[0.98] transition-all outline-none">
            Resume editing
            <IoArrowForward size={15} />
          </button>
          {latestExport && (
            <button
              type="button"
              onClick={() => onSendToPhone(latestExport)}
              title={`Send ${latestExport.name} to your phone`}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 text-sm font-medium text-gray-700 dark:text-neutral-200 hover:border-blue-400 transition-colors outline-none"
            >
              <IoPhonePortraitOutline size={15} />
              Send export to phone
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

// ---- The screen -------------------------------------------------------------------------------

const VideoEditorHome: React.FC<VideoEditorHomeProps> = ({ videos, recentPaths, resolveThumbnailUrl, onOpenVideo, onOpenExternalVideo, onCreateVideo, onSendToPhone, externalDrag = false, droppedPaths = null, onTidyUp }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  // A starter waiting for its video.
  const [picking, setPicking] = useState<Starter | null>(null);
  const [thumbUrls, putThumbUrl] = useBatchedRecord<string>();
  const [probes, putProbe] = useBatchedRecord<VideoProbe>();
  const [edits, setEdits] = useState<Record<string, EditSummary | null>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLElement>(null);

  // Dashboard passes new arrows every render - refs keep the memoized tiles from re-rendering.
  const onOpenVideoRef = useRef(onOpenVideo);
  onOpenVideoRef.current = onOpenVideo;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const openVideo = useCallback((video: VideoEditorFile) => {
    const starter = pickingRef.current;
    setPicking(null);
    onOpenVideoRef.current(video, starter?.intent);
  }, []);
  const onSendRef = useRef(onSendToPhone);
  onSendRef.current = onSendToPhone;
  const sendToPhone = useCallback((video: VideoEditorFile) => onSendRef.current([{ path: video.path, name: video.name }]), []);

  // What a tile needs once it's on screen: its poster, length and shape, and its edit.
  const requested = useRef(new Set<string>());
  const videosByPath = useMemo(() => new Map(videos.map((v) => [v.path, v])), [videos]);
  const resolveRef = useRef(resolveThumbnailUrl);
  resolveRef.current = resolveThumbnailUrl;
  const loadMeta = useCallback(
    (path: string) => {
      if (requested.current.has(path)) return;
      const video = videosByPath.get(path);
      if (!video) return;
      requested.current.add(path);
      thumbnailLimiter(() => resolveRef.current(video))
        .then((url) => putThumbUrl(path, url))
        .catch((err) => console.error(`Failed to resolve thumbnail for ${path}:`, err));
      if (!isVideoProjectPath(path)) probeVideo(video).then((p) => putProbe(path, p)).catch(() => {});
      readEditSummary(path)
        .then((s) => setEdits((prev) => ({ ...prev, [path]: s })))
        .catch(() => setEdits((prev) => ({ ...prev, [path]: null })));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videosByPath]
  );

  const recentVideos = useMemo(
    () => recentPaths.map((path) => videosByPath.get(path)).filter((video): video is VideoEditorFile => video !== undefined),
    [videosByPath, recentPaths]
  );
  // The recent ones are read straight away - the newest edited one leads the screen.
  useEffect(() => {
    recentVideos.slice(0, 8).forEach((v) => loadMeta(v.path));
  }, [recentVideos, loadMeta]);
  const continueVideo = recentVideos.slice(0, 8).find((v) => edits[v.path]);
  const continueEdit = continueVideo ? edits[continueVideo.path] ?? null : null;

  // Filters and sorts that depend on every video's details read them all (still through the limiter).
  const needsAll = filter === "edited" || filter === "vertical" || sort === "length";
  useEffect(() => {
    if (needsAll) videos.forEach((v) => loadMeta(v.path));
  }, [needsAll, videos, loadMeta]);

  // Projects and exports outside their folders (the tidy-up offer) - offered again only once the
  // count changes after "Not now".
  const strays = useMemo(() => {
    const inFolder = (p: string, folder: string) => p.split(/[\\/]/).slice(-2, -1)[0]?.toLowerCase() === folder.toLowerCase();
    const projects = videos.filter((v) => isVideoProjectPath(v.path) && !inFolder(v.path, "Projects")).length;
    const exports = videos.filter((v) => !isVideoProjectPath(v.path) && isExportName(v.path) && !inFolder(v.path, "Exports")).length;
    return { projects, exports, key: `${projects}|${exports}` };
  }, [videos]);
  const [tidyDismissed, setTidyDismissed] = useState(() => {
    try {
      return localStorage.getItem("briefcast.tidyDismissed") ?? "";
    } catch {
      return "";
    }
  });
  const dismissTidy = (key: string) => {
    setTidyDismissed(key);
    try {
      localStorage.setItem("briefcast.tidyDismissed", key);
    } catch {
      // Shown again next time.
    }
  };

  // Each video's exports, by the name they share - grouped onto its tile in the library.
  const { exportsByBase, sourceBases } = useMemo(() => {
    const exportsByBase = new Map<string, VideoEditorFile[]>();
    const sourceBases = new Set<string>();
    for (const v of videos) {
      if (!isVideoProjectPath(v.path) && isExportName(v.path)) {
        const key = exportBase(v.path);
        exportsByBase.set(key, [...(exportsByBase.get(key) ?? []), v]);
      } else sourceBases.add(exportBase(v.path));
    }
    exportsByBase.forEach((list) => list.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)));
    return { exportsByBase, sourceBases };
  }, [videos]);

  const query = searchQuery.trim().toLowerCase();
  const libraryVideos = useMemo(() => {
    const matching = videos.filter((video) => {
      if (query && !video.name.toLowerCase().includes(query)) return false;
      // Shown on their video's tile, in the plain library view.
      if (filter === "all" && !query && isExportName(video.path) && !isVideoProjectPath(video.path) && sourceBases.has(exportBase(video.path))) return false;
      if (filter === "edited") return !!edits[video.path];
      if (filter === "vertical") return isVertical(probes[video.path]) || (edits[video.path]?.canvasAspect ?? 1) < 1;
      if (filter === "exports") return isExportName(video.path);
      if (filter === "projects") return isVideoProjectPath(video.path);
      return true;
    });
    const length = (v: VideoEditorFile) => edits[v.path]?.outputDuration || probes[v.path]?.duration || 0;
    const changed = (v: VideoEditorFile) => Math.max(edits[v.path]?.updatedAt ?? 0, v.modified ?? 0);
    return [...matching].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "size" ? b.size - a.size : sort === "length" ? length(b) - length(a) : changed(b) - changed(a) || a.name.localeCompare(b.name)
    );
  }, [videos, query, filter, sort, edits, probes, sourceBases]);

  // A video dropped on the window opens - set up for the starter that was asking, if one was.
  useEffect(() => {
    const path = droppedPaths?.paths.find((p) => getFileCategory(p) === "video");
    if (!path) return;
    openVideo(videosByPath.get(path) ?? { path, name: path.split(/[\\/]/).pop() ?? path, size: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedPaths]);

  // A tile moves once the pointer has rested on it a moment.
  useEffect(() => {
    if (!hovered) {
      setPreviewPath(null);
      return;
    }
    const timer = window.setTimeout(() => setPreviewPath(hovered), HOVER_PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hovered]);

  // VideoPlayer's "set current frame as thumbnail" rewrites the cached jpg at the same path -
  // bypassCache=true is what gets the new bytes.
  useEffect(() => {
    const unlistenPromise = listen<string>("video-thumbnail-updated", (event) => {
      const file = videosByPath.get(event.payload);
      if (!file) return;
      resolveRef.current(file, true)
        .then((url) => putThumbUrl(file.path, url, true))
        .catch((err) => console.error(`Failed to refresh thumbnail for ${file.path}:`, err));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videosByPath]);

  // "/" finds a video; Esc lets go of a starter's question.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && pickingRef.current) setPicking(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const startStarter = (starter: Starter) => {
    setPicking(starter);
    setFilter("all");
    requestAnimationFrame(() => libraryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const filterChip = (id: Filter, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setFilter(id)}
      className={`h-7 px-3 rounded-full text-xs font-medium transition-colors outline-none ${
        filter === id ? "bg-gray-900 text-white dark:bg-white dark:text-neutral-900" : "bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700"
      }`}
    >
      {label}
    </button>
  );

  const renderTile = (video: VideoEditorFile): React.ReactNode => (
    <VideoTile
      key={video.path}
      video={video}
      thumbUrl={thumbUrls[video.path]}
      probe={probes[video.path]}
      edit={edits[video.path]}
      previewing={previewPath === video.path}
      picking={!!picking}
      exports={filter === "exports" || isExportName(video.path) ? undefined : exportsByBase.get(exportBase(video.path))}
      onOpen={openVideo}
      onVisible={loadMeta}
      onHover={setHovered}
      onSendToPhone={sendToPhone}
    />
  );

  return (
    <div className="relative w-full h-full overflow-y-auto bg-gray-100 dark:bg-neutral-950">
      <div className="max-w-6xl mx-auto px-6 py-8 pb-24">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex items-center gap-3 mr-auto">
            <span className="p-2 rounded-lg bg-blue-500/10 text-blue-500 dark:text-blue-400">
              <IoCutOutline size={22} />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-gray-800 dark:text-neutral-100">Video editor</h1>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Cut, caption, split-screen and reformat - then send it straight to your phone.</p>
            </div>
          </div>
          {videos.length >= SEARCH_VISIBLE_THRESHOLD && (
            <div className="relative w-full sm:w-72">
              <IoSearchOutline size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 pointer-events-none" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search videos"
                className="w-full pl-9 pr-9 py-2.5 rounded-lg text-sm bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 text-gray-800 dark:text-neutral-100 placeholder:text-neutral-400 focus:border-blue-400 dark:focus:border-blue-500 outline-none"
              />
              <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400 border border-gray-200 dark:border-neutral-700 rounded px-1">/</kbd>
            </div>
          )}
        </div>

        {continueVideo && continueEdit && !query && !picking && (
          <ContinueCard
            video={continueVideo}
            thumbUrl={thumbUrls[continueVideo.path]}
            probe={probes[continueVideo.path]}
            edit={continueEdit}
            latestExport={exportsByBase.get(exportBase(continueVideo.path))?.[0] ?? exportsOf(continueVideo.path, videos)[0]}
            onResume={() => openVideo(continueVideo)}
            onSendToPhone={sendToPhone}
          />
        )}

        {onTidyUp && !query && !picking && strays.projects + strays.exports > 0 && strays.key !== tidyDismissed && (
          <div className="mt-6 flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800">
            <IoSparkles size={18} className="text-blue-500 shrink-0" />
            <p className="flex-1 min-w-[14rem] text-sm text-neutral-600 dark:text-neutral-300">
              {[strays.projects ? `${strays.projects} project${strays.projects === 1 ? "" : "s"}` : null, strays.exports ? `${strays.exports} finished video${strays.exports === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ")}{" "}
              {strays.projects + strays.exports === 1 ? "is" : "are"} mixed in with your other files. Give them their own folders?
            </p>
            <button type="button" onClick={onTidyUp} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
              Tidy up…
            </button>
            <button type="button" onClick={() => dismissTidy(strays.key)} aria-label="Not now" title="Not now" className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-800">
              <IoClose size={15} />
            </button>
          </div>
        )}

        {!query && (
          <section className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-3">Start something new</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <StarterCard id="open" title="Open a video" hint="From anywhere on your computer" onClick={() => onOpenExternalVideo()} />
              <StarterCard id="photos" title="From photos" hint="Turn pictures into a video" onClick={onCreateVideo} />
              {STARTERS.map((s) => (
                <StarterCard key={s.id} id={s.id} title={s.title} hint={s.hint} isNew={s.isNew} active={picking?.id === s.id} onClick={() => (picking?.id === s.id ? setPicking(null) : startStarter(s))} />
              ))}
            </div>
          </section>
        )}

        <section ref={libraryRef} className="mt-8 scroll-mt-4">
          {picking && (
            <div className="mb-4 flex flex-wrap items-center gap-3 p-3 rounded-xl bg-blue-600 text-white shadow-md">
              <span className="w-8 h-10 flex items-center justify-center text-white/90">
                {picking.id === "split" ? <MdViewQuilt size={22} /> : <StarterArt id={picking.id} />}
              </span>
              <span className="flex-1 min-w-[12rem] text-sm">
                <span className="font-semibold">Pick a video for {picking.title.toLowerCase()}</span>
                <span className="block text-white/75 text-xs">It opens in the editor ready to go - {picking.hint.toLowerCase()}.</span>
              </span>
              <button type="button" onClick={() => onOpenExternalVideo(picking.intent)} className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-medium transition-colors">
                From your computer…
              </button>
              <button type="button" onClick={() => setPicking(null)} aria-label="Cancel" className="p-1.5 rounded-lg hover:bg-white/15 transition-colors">
                <IoClose size={16} />
              </button>
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {query ? `Results (${libraryVideos.length})` : `Library · ${videos.length}`}
            </h2>
            {filterChip("all", "All")}
            {filterChip("edited", "Edited")}
            {filterChip("vertical", "Vertical")}
            {filterChip("exports", "Exports")}
            {videos.some((v) => isVideoProjectPath(v.path)) && filterChip("projects", "Projects")}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="h-7 px-2 rounded-md bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 text-xs text-gray-700 dark:text-neutral-200 outline-none focus:border-blue-400"
              >
                <option value="recent">Recently changed</option>
                <option value="name">Name</option>
                <option value="length">Longest</option>
                <option value="size">Largest</option>
              </select>
            </label>
          </div>
          {libraryVideos.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">{libraryVideos.map(renderTile)}</div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-14 rounded-xl border border-dashed border-gray-300 dark:border-neutral-800 text-center">
              <IoFilmOutline size={32} className="text-neutral-300 dark:text-neutral-700" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {query ? `No videos match "${searchQuery.trim()}".` : filter !== "all" ? "Nothing here yet." : "No videos in your library yet - drop one here, or open one from your computer."}
              </p>
              {!query && filter === "all" && (
                <button type="button" onClick={() => onOpenExternalVideo()} className="mt-1 text-sm text-blue-600 dark:text-blue-400 hover:underline outline-none">
                  Open a video
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      {/* A video dragged in from outside: dropped anywhere, it opens for editing. */}
      {externalDrag && (
        <div className="pointer-events-none absolute inset-3 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/10 backdrop-blur-[2px] flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 px-6 py-5 rounded-2xl bg-white/95 dark:bg-neutral-900/95 shadow-xl">
            <IoCloudUploadOutline size={34} className="text-blue-600 dark:text-blue-400" />
            <p className="text-sm font-semibold text-gray-800 dark:text-neutral-100">Drop to start editing</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{picking ? `It opens set up for ${picking.title.toLowerCase()}` : "Any video file"}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoEditorHome;
