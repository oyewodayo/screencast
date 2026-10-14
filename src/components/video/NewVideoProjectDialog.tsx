// components/video/NewVideoProjectDialog.tsx
//
// The Video Editor's "Create video" dialog - builds a new video project (services/video_edits.rs)
// out of still images: pick photos from the library and/or anywhere on disk, put them in order,
// choose a frame shape and how each image should play, and the editor opens on a timeline with one
// clip per image. Picking nothing starts a blank timeline instead, to fill by dropping media on it.
// Everything chosen here is only a starting point - every clip stays fully editable afterwards
// (length, Ken Burns, transitions, crop, color), and music/text/overlays are added in the editor.
import React, { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoAdd, IoCheckmark, IoChevronBack, IoChevronForward, IoClose, IoFolderOpenOutline, IoImageOutline } from "react-icons/io5";
import { thumbnailLimiter } from "../../utils/concurrencyLimiter";
import { truncateFileName } from "../../utils/Formater";
import { DEFAULT_IMAGE_CLIP_SECONDS, IMAGE_CLIP_EXTENSIONS, NewProjectOptions, VideoProjectFrame } from "../../utils/videoEditTypes";

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

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const NewVideoProjectDialog: React.FC<NewVideoProjectDialogProps> = ({ libraryImages, resolveThumbnailUrl, onCreate, onClose }) => {
  const [name, setName] = useState("Untitled video");
  const [frameId, setFrameId] = useState(FRAME_PRESETS[0].id);
  // In clip order - the order images were picked in, adjustable with the arrows on each tile.
  const [picked, setPicked] = useState<string[]>([]);
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_CLIP_SECONDS);
  const [kenBurns, setKenBurns] = useState(true);
  const [crossfade, setCrossfade] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

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

  const togglePicked = (path: string) =>
    setPicked((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  const movePicked = (index: number, delta: number) =>
    setPicked((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const handleBrowse = async () => {
    const selected = await openFileDialog({ multiple: true, filters: [{ name: "Images", extensions: IMAGE_CLIP_EXTENSIONS }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setPicked((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]);
  };

  const handleCreate = async () => {
    const frame = FRAME_PRESETS.find((preset) => preset.id === frameId)?.frame ?? FRAME_PRESETS[0].frame;
    setIsCreating(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim() || "Untitled video",
        frame,
        imagePaths: picked,
        options: { imageDuration, kenBurns, transition: crossfade ? "fade" : null },
      });
    } catch (err) {
      setError(`Couldn't create the video: ${err instanceof Error ? err.message : err}`);
      setIsCreating(false);
    }
  };

  const renderThumb = (path: string) =>
    thumbUrls[path] ? (
      <img src={thumbUrls[path]} alt="" className="w-full h-full object-cover" draggable={false} />
    ) : (
      <IoImageOutline size={20} className="text-neutral-300 dark:text-neutral-600" />
    );

  const totalSeconds = picked.length * imageDuration;
  const labelClass = "block text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-2";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !isCreating && onClose()}>
      <div
        role="dialog"
        aria-labelledby="new-video-project-title"
        className="w-full max-w-3xl max-h-full flex flex-col rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 shadow-xl"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 dark:border-neutral-800">
          <h2 id="new-video-project-title" className="flex-1 text-base font-semibold text-gray-800 dark:text-neutral-100">
            Create a video from images
          </h2>
          <button type="button" onClick={onClose} disabled={isCreating} aria-label="Close" className="p-1.5 -m-1 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
            <div>
              <label htmlFor="new-video-project-name" className={labelClass}>
                Name
              </label>
              <input
                id="new-video-project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-md text-sm bg-white dark:bg-neutral-950 border border-gray-200 dark:border-neutral-800 text-gray-800 dark:text-neutral-100 focus:border-blue-400 dark:focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <span className={labelClass}>Frame</span>
              <div className="flex gap-2">
                {FRAME_PRESETS.map((preset) => {
                  const active = preset.id === frameId;
                  const scale = 22 / Math.max(preset.frame.width, preset.frame.height);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setFrameId(preset.id)}
                      title={`${preset.label} (${preset.frame.width}×${preset.frame.height})`}
                      className={`flex flex-col items-center gap-1 w-16 py-1.5 rounded-md border text-[11px] transition-colors outline-none ${
                        active
                          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "border-gray-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:border-blue-300 dark:hover:border-blue-700"
                      }`}
                    >
                      <span className="h-6 flex items-center">
                        <span
                          className={`block rounded-[2px] border-2 ${active ? "border-blue-500" : "border-neutral-400 dark:border-neutral-500"}`}
                          style={{ width: preset.frame.width * scale, height: preset.frame.height * scale }}
                        />
                      </span>
                      {preset.hint}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="new-video-project-duration" className={labelClass}>
                Each image
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="new-video-project-duration"
                  type="number"
                  min={0.5}
                  max={60}
                  step={0.5}
                  value={imageDuration}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isFinite(value)) setImageDuration(Math.min(60, Math.max(0.5, value)));
                  }}
                  className="w-20 px-3 py-2 rounded-md text-sm bg-white dark:bg-neutral-950 border border-gray-200 dark:border-neutral-800 text-gray-800 dark:text-neutral-100 focus:border-blue-400 dark:focus:border-blue-500 outline-none tabular-nums"
                />
                <span className="text-sm text-neutral-500 dark:text-neutral-400">seconds</span>
              </div>
            </div>
            {[
              { id: "kenburns", label: "Slow zoom & pan", hint: "Ken Burns motion on every image", value: kenBurns, set: setKenBurns },
              { id: "crossfade", label: "Crossfade", hint: "Fade from each image into the next", value: crossfade, set: setCrossfade },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                role="checkbox"
                aria-checked={option.value}
                onClick={() => option.set(!option.value)}
                className="flex items-start gap-2.5 text-left outline-none sm:pt-6"
              >
                <span
                  className={`mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center ${
                    option.value ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 dark:border-neutral-600"
                  }`}
                >
                  {option.value && <IoCheckmark size={12} />}
                </span>
                <span>
                  <span className="block text-sm text-gray-800 dark:text-neutral-100">{option.label}</span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className={`${labelClass} mb-0`}>
                Clips{picked.length > 0 ? ` (${picked.length})` : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 outline-none"
              >
                <IoFolderOpenOutline size={14} />
                Add from computer…
              </button>
            </div>
            {picked.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {picked.map((path, i) => (
                  <div key={path} className="group relative shrink-0 w-28">
                    <div className="relative aspect-video rounded-md overflow-hidden bg-neutral-100 dark:bg-neutral-950 border border-gray-200 dark:border-neutral-800 flex items-center justify-center">
                      {renderThumb(path)}
                      <span className="absolute top-1 left-1 px-1.5 rounded bg-black/60 text-[10px] font-medium text-white tabular-nums">{i + 1}</span>
                      <button
                        type="button"
                        onClick={() => togglePicked(path)}
                        aria-label="Remove"
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <IoClose size={12} />
                      </button>
                      <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" onClick={() => movePicked(i, -1)} disabled={i === 0} aria-label="Move earlier" className="p-0.5 rounded bg-black/60 text-white disabled:opacity-30">
                          <IoChevronBack size={12} />
                        </button>
                        <button type="button" onClick={() => movePicked(i, 1)} disabled={i === picked.length - 1} aria-label="Move later" className="p-0.5 rounded bg-black/60 text-white disabled:opacity-30">
                          <IoChevronForward size={12} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 truncate">{truncateFileName(baseName(path), 18)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
                Pick images below or from your computer. They'll play in the order you pick them. Leave this empty to start with a blank timeline and drop media onto it later.
              </p>
            )}
          </div>

          {libraryImages.length > 0 && (
            <div>
              <span className={labelClass}>From your library</span>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {libraryImages.map((image) => {
                  const order = picked.indexOf(image.path);
                  return (
                    <button
                      key={image.path}
                      type="button"
                      onClick={() => togglePicked(image.path)}
                      title={image.name}
                      className={`relative aspect-square rounded-md overflow-hidden bg-neutral-100 dark:bg-neutral-950 border-2 flex items-center justify-center outline-none transition-colors ${
                        order >= 0 ? "border-blue-500" : "border-transparent hover:border-blue-300 dark:hover:border-blue-700"
                      }`}
                    >
                      {renderThumb(image.path)}
                      {order >= 0 && (
                        <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white flex items-center justify-center tabular-nums">
                          {order + 1}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-100 dark:border-neutral-800">
          <p className="flex-1 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
            {picked.length > 0 ? `About ${Math.round(totalSeconds)}s long. Add music, text and overlays in the editor.` : "Starts as an empty timeline."}
          </p>
          <button type="button" onClick={onClose} disabled={isCreating} className="px-3 py-2 rounded-md text-sm text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/10 outline-none">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={isCreating}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 outline-none"
          >
            <IoAdd size={16} />
            {isCreating ? "Creating…" : picked.length > 0 ? "Create video" : "Start blank"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewVideoProjectDialog;
