// utils/concurrencyLimiter.ts
//
// A plain FIFO semaphore - caps how many async operations from ANY caller run at once, not per
// caller. Built for image thumbnail generation specifically (see thumbnailLimiter below): the
// sidebar's SidebarFileIcon and the image gallery's ImageFolderGallery both independently decide
// when they're ready to resolve a thumbnail, but they ultimately all hit the same backend command
// (get_image_thumbnail), which for a plain (non-HEIC) image does a full decode-resize-encode of
// the original file in memory - not cheap for a real 12+ megapixel photo. Left uncapped (or capped
// only per-component), simply expanding a folder with hundreds of photos in the sidebar can fire
// dozens of these at once - IntersectionObserver's rootMargin means many rows become "visible" in
// the same instant, not one at a time as you scroll - pegging every CPU core and spiking memory
// hard enough to freeze the whole app ("Not Responding", fan noise, multi-GB RAM growth - observed
// directly). A single SHARED limiter is what actually fixes that: it doesn't matter how many
// callers want a thumbnail right now, only how many run at once, app-wide.
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= maxConcurrent) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };

  return function withLimit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<void>((resolve) => {
      queue.push(resolve);
      runNext();
    }).then(task).finally(() => {
      active--;
      runNext();
    });
  };
}

// One shared limiter for every thumbnail request in the app (sidebar rows, gallery tiles) - see
// this file's own doc comment for why a per-component cap isn't enough on its own.
export const thumbnailLimiter = createLimiter(4);
