// utils/stage/stageExport.ts
//
// Renders a Stage scene for an export: every frame drawn by the same renderer the preview uses, at
// the export's size and rate, read back and sent to stage_render.rs as raw bytes, which writes them
// as PNGs the export composites (StageLayerSpec, conversion.rs). A frame identical
// to the one before - nothing moving, no value ticking - isn't drawn or sent at all, so a scene that
// is mostly at rest costs little. A few frames are in flight at once: the next one draws while the
// last is still on its way.
import { invoke } from "@tauri-apps/api/core";
import { compileStage, stageIsMoving } from "./stageEngine";
import { loadStageImages } from "./stageImages";
import { canvasStageMeasure, loadStageFonts } from "./stageMeasure";
import { StageRenderer } from "./stageRenderer";
import type { StageScene } from "./stageTypes";

// What the export needs to composite the scene (StageLayerSpec, conversion.rs): the stored frames as
// an image sequence and the scene frame each starts at.
export interface StageLayerSpec {
  pattern: string;
  frames: number[];
  startTime: number;
  endTime: number;
  fps: number;
}

export interface StageExportProgress {
  frame: number;
  frames: number;
  // Frames actually drawn and sent so far (the rest repeat the one before).
  sent: number;
}

// Frames encoded to QOI in workers (stageQoiWorker.ts) - all but one core, at most four.
const WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const IN_FLIGHT = WORKERS + 1;

// A small pool: each job hands a frame's pixels over (transferred) and gets the QOI file back, with
// the pixel buffer returned for the next frame.
function qoiPool(size: number) {
  const workers = Array.from({ length: size }, () => new Worker(new URL("./stageQoiWorker.ts", import.meta.url), { type: "module" }));
  const waiting = new Map<number, { resolve: (r: { qoi: Uint8Array; pixels: Uint8Array }) => void; reject: (e: unknown) => void }>();
  const busy = new Set<Worker>();
  const queue: (() => void)[] = [];
  let next = 1;
  for (const w of workers) {
    w.onmessage = (e: MessageEvent<{ id: number; qoi: ArrayBuffer; pixels: ArrayBuffer }>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      busy.delete(w);
      queue.shift()?.();
      job?.resolve({ qoi: new Uint8Array(e.data.qoi), pixels: new Uint8Array(e.data.pixels) });
    };
    w.onerror = (e) => {
      for (const job of waiting.values()) job.reject(e);
      waiting.clear();
    };
  }
  const encode = (pixels: Uint8Array, width: number, height: number) =>
    new Promise<{ qoi: Uint8Array; pixels: Uint8Array }>((resolve, reject) => {
      const run = () => {
        const w = workers.find((x) => !busy.has(x))!;
        busy.add(w);
        const id = next++;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, pixels: pixels.buffer, width, height }, [pixels.buffer]);
      };
      if (busy.size < workers.length) run();
      else queue.push(run);
    });
  return { encode, dispose: () => workers.forEach((w) => w.terminate()) };
}

export async function renderStageForExport(
  scene: StageScene,
  opts: { width: number; height: number; fps: number; signal?: AbortSignal; onProgress?: (p: StageExportProgress) => void }
): Promise<StageLayerSpec> {
  const setupBegan = performance.now();
  // Text is measured in its own faces and weights - a fallback would put every letter somewhere else.
  await Promise.all([loadStageFonts(scene), loadStageImages(scene)]);
  const loadedMs = performance.now() - setupBegan;
  const compiled = compileStage(scene, canvasStageMeasure);
  const canvas = document.createElement("canvas");
  const renderer = new StageRenderer(canvas, opts.width, opts.height);
  const { width, height } = renderer.pixelSize;
  const session = await invoke<{ id: number; dir: string; port: number | null; token: string | null }>("stage_render_open", { width, height, fps: opts.fps });
  // Frames go to the app's loopback endpoint - WebView2 moves IPC bodies at ~7 MB/s, over a second
  // a 1080p frame - and by IPC if that can't be reached.
  let loopback = session.port != null && session.token != null;
  // Each frame goes over as the QOI file a worker made of it - tens of kilobytes, not 8 MB.
  const sendFrame = async (qoi: Uint8Array, k: number): Promise<void> => {
    if (loopback) {
      try {
        // As a Blob: WebView2 uploads one 2-3x faster than the same bytes as an ArrayBuffer (measured).
        const res = await fetch(`http://127.0.0.1:${session.port}/frame/${session.id}/${k}?f=qoi&t=${session.token}`, { method: "POST", body: new Blob([qoi], { type: "text/plain" }) });
        if (res.ok) return;
        throw new Error(await res.text());
      } catch (e) {
        // A frame Rust refused is an error either way; only an unreachable endpoint falls back.
        if (e instanceof Error && !(e instanceof TypeError)) throw e;
        loopback = false;
      }
    }
    await invoke<void>("stage_render_frame", qoi, { headers: { "x-stage-id": String(session.id), "x-frame-index": String(k), "x-format": "qoi" } });
  };
  const pool = qoiPool(WORKERS);
  try {
    renderer.prepare(compiled);
    const frames = Math.max(1, Math.round(compiled.duration * opts.fps));
    // Buffers come back from the encoders for reuse.
    const free: Uint8Array[] = [];
    const inFlight = new Set<Promise<void>>();
    // Frames drawn whose pixels are still on their way back from the GPU (beginReadback).
    const reading: { k: number; rb: ReturnType<StageRenderer["beginReadback"]> }[] = [];
    const READ_AHEAD = 3;
    // Where an export's time goes, kept for diagnosis (window.__stageExportStats).
    const stats = { loadMs: loadedMs, setupMs: performance.now() - setupBegan, frames: 0, renderMs: 0, waitGpuMs: 0, copyMs: 0, encodeMs: 0, sendMs: 0, totalMs: 0 };
    const began = performance.now();
    let sent = 0;
    const dispatch = async (all: boolean) => {
      while (reading.length && (all || reading.length >= READ_AHEAD || reading[0].rb.ready())) {
        const { k, rb } = reading[0];
        const w0 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        while (!rb.ready()) await new Promise((r) => setTimeout(r, 1));
        const c0 = performance.now();
        stats.waitGpuMs += c0 - w0;
        reading.shift();
        const buf = rb.read(free.pop());
        stats.copyMs += performance.now() - c0;
        const e0 = performance.now();
        const send = pool
          .encode(buf, width, height)
          .then(({ qoi, pixels }) => {
            free.push(pixels);
            stats.encodeMs += performance.now() - e0;
            const s0 = performance.now();
            return sendFrame(qoi, k).then(() => {
              stats.sendMs += performance.now() - s0;
            });
          })
          .then(() => {
            inFlight.delete(send);
          });
        inFlight.add(send);
        sent++;
        // eslint-disable-next-line no-await-in-loop
        if (inFlight.size >= IN_FLIGHT) await Promise.race(inFlight);
      }
    };
    for (let k = 0; k < frames; k++) {
      if (opts.signal?.aborted) {
        reading.forEach((r) => r.rb.cancel());
        throw new DOMException("Export cancelled", "AbortError");
      }
      const t = k / opts.fps;
      // The same picture as the frame before when nothing was moving then and nothing starts by now.
      if (k > 0 && !stageIsMoving(compiled, (k - 1) / opts.fps, t)) continue;
      const r0 = performance.now();
      renderer.render(compiled, t);
      reading.push({ k, rb: renderer.beginReadback() });
      stats.renderMs += performance.now() - r0;
      stats.frames++;
      await dispatch(false);
      opts.onProgress?.({ frame: k + 1, frames, sent });
    }
    await dispatch(true);
    await Promise.all(inFlight);
    stats.totalMs = performance.now() - began;
    (globalThis as unknown as { __stageExportStats?: unknown[] }).__stageExportStats = [...((globalThis as unknown as { __stageExportStats?: unknown[] }).__stageExportStats ?? []), { scene: scene.id, ...stats }];
    const done = await invoke<{ pattern: string; frames: number[] }>("stage_render_finish", { id: session.id, totalFrames: frames });
    opts.onProgress?.({ frame: frames, frames, sent });
    return { pattern: done.pattern, frames: done.frames, startTime: scene.startTime, endTime: scene.startTime + frames / opts.fps, fps: opts.fps };
  } catch (e) {
    await invoke("stage_render_discard", { id: session.id }).catch(() => undefined);
    throw e;
  } finally {
    pool.dispose();
    renderer.dispose();
  }
}
