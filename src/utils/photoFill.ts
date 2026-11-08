// utils/photoFill.ts
//
// A photo that isn't the video frame's shape fills the frame the way template editors do it: the
// whole photo, fitted, over a blurred, dimmed copy of itself stretched to cover - instead of black
// bars. Drawn here once at the frame's full resolution and stored as a still in the derived-media
// cache (store_derived_still, derived_images.rs), so it then previews, keyframes and exports like
// any other picture clip. The same drawing (drawPhotoFill, photoFillDraw.ts) is what the Create
// dialog's stage shows.
//
// The stills are made in a small pool of workers (photoFillWorker.ts) - decode, draw and encode all
// off the page's main thread, several photos at once. The page draws one itself only if a worker
// can't (no OffscreenCanvas filters, a file it couldn't read).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getFileExtension } from "./fileCategory";
import type { VideoProjectFrame } from "./videoEditTypes";
import { drawPhotoFill, needsPhotoFill } from "./photoFillDraw";
import type { FillReply } from "./photoFillWorker";

export { drawPhotoFill, needsPhotoFill };

// Bump when the look changes, so stored stills are made again.
const FILL_VERSION = 1;

// One worker per spare core, at most three - each photo's decode + encode is the heavy part.
export const FILL_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));

let pool: { run: (url: string, frame: VideoProjectFrame) => Promise<string | null> } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const POOL_IDLE_MS = 30_000;

// The worker pool, started on first use and let go after half a minute without work - nothing
// lingers in memory once the photos are made.
function fillPool() {
  if (pool) return pool;
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const queue: (() => void)[] = [];
  const waiting = new Map<number, { resolve: (jpeg: string | null) => void; reject: (e: Error) => void; worker: Worker }>();
  let next = 1;
  let busy = 0;
  const dispose = () => {
    for (const w of workers) w.terminate();
    for (const job of waiting.values()) job.reject(new Error("The photo worker stopped"));
    waiting.clear();
    pool = null;
  };
  const scheduleDispose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = busy === 0 ? setTimeout(dispose, POOL_IDLE_MS) : null;
  };
  // A finished worker takes the next photo; a broken one is dropped (the next photo gets a fresh one).
  const release = (w: Worker, healthy: boolean) => {
    busy--;
    if (healthy) idle.push(w);
    else {
      w.terminate();
      workers.splice(workers.indexOf(w), 1);
    }
    const run = queue.shift();
    if (run) run();
    else scheduleDispose();
  };
  const spawn = (): Worker => {
    const w = new Worker(new URL("./photoFillWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<FillReply>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      release(w, true);
      if (!job) return;
      if ("error" in e.data) job.reject(new Error(e.data.error));
      else job.resolve(e.data.jpegBase64);
    };
    w.onerror = (e) => {
      e.preventDefault();
      // A worker that can't run at all (a failed module load): its job falls back to the page.
      for (const [id, job] of waiting)
        if (job.worker === w) {
          waiting.delete(id);
          job.reject(new Error(e.message || "The photo worker failed"));
          release(w, false);
        }
    };
    workers.push(w);
    return w;
  };
  pool = {
    run: (url, frame) =>
      new Promise<string | null>((resolve, reject) => {
        const start = () => {
          const w = idle.pop() ?? spawn();
          busy++;
          if (idleTimer) clearTimeout(idleTimer);
          const id = next++;
          waiting.set(id, { resolve, reject, worker: w });
          w.postMessage({ id, url, width: frame.width, height: frame.height });
        };
        if (busy < FILL_WORKERS) start();
        else queue.push(start);
      }),
  };
  return pool;
}

// What the photo is read from: HEIC/HEIF through its cached decoded preview.
const readablePath = async (path: string): Promise<string> =>
  ["heic", "heif"].includes(getFileExtension(path)) ? invoke<string>("get_heic_preview", { inputPath: path }) : path;

// The photo, decoded on the page. `direct`: straight from its asset URL, read cross-origin so the
// canvas stays readable - instead of a data URL, which turned a phone photo (20 MB) into a ~27 MB
// base64 string carried across IPC and parsed on the page's main thread before decoding could even
// start. The data URL remains as the last fallback.
async function loadFullPhoto(path: string, direct: boolean): Promise<HTMLImageElement> {
  const source = await readablePath(path);
  const url = direct ? convertFileSrc(source) : await invoke<string>("read_image_data_url", { path: source });
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't open ${path}`));
    img.src = url;
  });
}

// The fill drawn on the page at the frame's size, as JPEG base64 - null when the photo needs none.
// Throws if the canvas can't be read (a photo the browser treats as foreign), which the caller
// retries via a data URL.
async function renderFillOnPage(path: string, frame: VideoProjectFrame, direct: boolean): Promise<string | null> {
  const img = await loadFullPhoto(path, direct);
  if (!needsPhotoFill(img.naturalWidth / img.naturalHeight, frame)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawPhotoFill(ctx, img, frame.width, frame.height);
  return canvas.toDataURL("image/jpeg", 0.93).split(",")[1];
}

async function renderFill(path: string, frame: VideoProjectFrame): Promise<string | null> {
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      return await fillPool().run(convertFileSrc(await readablePath(path)), frame);
    } catch (err) {
      console.warn(`Photo fill worker couldn't make ${path}, drawing it on the page instead:`, err);
    }
  }
  try {
    return await renderFillOnPage(path, frame, true);
  } catch {
    // The direct load failed or left the canvas unreadable - the slower data URL always works.
    return renderFillOnPage(path, frame, false);
  }
}

// A still of `path` filling `frame` (made once, then found in the cache) - or `path` itself when
// the photo is already the frame's shape. `aspect` (when known) skips opening photos that fit.
export async function photoFillPath(path: string, frame: VideoProjectFrame, aspect?: number): Promise<string> {
  if (aspect !== undefined && !needsPhotoFill(aspect, frame)) return path;
  const key = `${frame.width}x${frame.height}|v${FILL_VERSION}`;
  const stored = await invoke<string | null>("store_derived_still", { sourcePath: path, kind: "fill", key, jpegBase64: null });
  if (stored) return stored;
  const jpeg = await renderFill(path, frame);
  if (!jpeg) return path;
  return (await invoke<string | null>("store_derived_still", { sourcePath: path, kind: "fill", key, jpegBase64: jpeg })) ?? path;
}
