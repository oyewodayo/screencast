// utils/stage/stageQoiWorker.ts
//
// Encodes a Stage export frame to QOI off the main thread: premultiplied RGBA as WebGL reads it
// (rows bottom first) in, a straight-alpha top-first QOI file out - the same bytes Rust's
// pixel_convert::qoi_from_premultiplied writes. A 1080p motion-graphics frame becomes ~50-150 KB, so
// what crosses into the app is that rather than 8 MB of raw pixels (WebView2 uploads raw frames at
// ~40 MB/s at best). Buffers move in and out as transfers, never copied.

import { qoiFromPremultiplied } from "./stageQoi";

interface Job {
  id: number;
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, pixels, width, height } = e.data;
  const qoi = qoiFromPremultiplied(new Uint8Array(pixels), width, height);
  // The pixel buffer goes back for reuse along with the frame.
  (self as unknown as Worker).postMessage({ id, qoi: qoi.buffer, pixels }, [qoi.buffer, pixels]);
};

export {};
