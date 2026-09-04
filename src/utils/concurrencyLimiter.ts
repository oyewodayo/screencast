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
// A task that never settles - an invoke() stuck on something below the JS promise layer (seen in
// practice: a request that produced no backend log line, no error, no result, indefinitely, with
// the Rust process sitting fully idle - so not a slow decode, an actual hang) - would otherwise
// hold its slot forever. Since active only ever goes back down inside the `finally` below, one
// such hang permanently shrinks this limiter's real capacity by one; enough of them (plausible
// over a long session touching many folders) and every future caller, including totally unrelated
// ones like SidebarFileIcon, queues forever behind a queue that can never drain. Racing every task
// against this timeout guarantees the slot always gets released - the abandoned task's own promise
// (uncancellable; the JS side has no way to actually stop an in-flight invoke) just settles later
// into the void, unread.
const DEFAULT_TASK_TIMEOUT_MS = 45000;

export function createLimiter(maxConcurrent: number, taskTimeoutMs: number = DEFAULT_TASK_TIMEOUT_MS) {
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
    }).then(() => {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out after ${taskTimeoutMs}ms waiting for task`)), taskTimeoutMs);
      });
      return Promise.race([task(), timeout]).finally(() => {
        active--;
        runNext();
      });
    });
  };
}

// One shared limiter for every thumbnail request in the app (sidebar rows, gallery tiles) - see
// this file's own doc comment for why a per-component cap isn't enough on its own.
export const thumbnailLimiter = createLimiter(4);
